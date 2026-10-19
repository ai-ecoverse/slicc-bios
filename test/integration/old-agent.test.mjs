import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { AGENT_BUDGET, agentUp, connectAccount, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';
import { shoot } from './shots.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const deployed = (version) =>
  Object.fromEntries(
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((file) => [
      `/packages/agent/${file}`,
      readFileSync(new URL(`fixtures/agent-${version}/${file}`, import.meta.url), 'utf8'),
    ])
  );
const NEW_VERSION = JSON.parse(
  readFileSync(new URL('../../src/packages/agent/package.json', import.meta.url), 'utf8')
).dependencies['@ai-ecoverse/slicc-agent'];

const answer = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the agent.' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const chrome = await launch({ agent: true, timeout: 60000 });
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
  key: 'the-key',
  answer: async (request) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: answer,
    };
  },
});
after(async () => {
  await proxy.close();
  await chrome.close();
});

const helpers = () => {
  window.deep = (root, selector) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && window.deep(element.shadowRoot, selector);
      if (inner) return inner;
    }
    return null;
  };
  window.deepText = (root) =>
    [...root.childNodes]
      .map((node) =>
        node.nodeType === Node.TEXT_NODE
          ? node.textContent
          : `${node.shadowRoot ? window.deepText(node.shadowRoot) : ''}${window.deepText(node)}`
      )
      .join('');
  window.chatView = () => {
    const dock = document.querySelector('slicc-app').dock;
    const ids = dock.api.panels.map((panel) => panel.id);
    const chats = [
      ...ids.filter((id) => id.startsWith('chat:')),
      ...ids.filter((id) => id === 'chat'),
    ];
    return chats.map((id) => dock.content(id)).find((view) => view?.shadowRoot) ?? null;
  };

  window.readOpfs = async (path) => {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    try {
      let dir = await navigator.storage.getDirectory();
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  };
  window.installedAgent = async () =>
    JSON.parse(
      (await window.readOpfs('/opt/agent/node_modules/@ai-ecoverse/slicc-agent/package.json')) ??
        '{}'
    ).version ?? null;
  window.agentRows = [];
  window.installNotice = () =>
    document
      .querySelector('slicc-app')
      ?.model?.notices?.list?.()
      .find((notice) => notice.id.startsWith('agent:installing:')) ?? null;
  window.noticeSeen = false;
  const watch = () => {
    const { updates, notices } = document.querySelector('slicc-app')?.model ?? {};
    if (!updates?.on || !notices?.on) return setTimeout(watch, 20);
    const seen = (list) => {
      if (list.some((notice) => notice.id.startsWith('agent:installing:')))
        window.noticeSeen = true;
    };
    seen(notices.list());
    notices.on('notices', seen);
    const note = () => {
      const { state, from, to } = updates.list().find((item) => item.id === 'agent');
      const last = window.agentRows.at(-1);
      if (last?.state !== state || last?.from !== from || last?.to !== to)
        window.agentRows.push({ state, from, to, at: Date.now() });
    };
    note();
    updates.on('items', note);
  };
  watch();
};

const agentRow = () =>
  document
    .querySelector('slicc-app')
    .model.updates.list()
    .find((item) => item.id === 'agent');

async function installedOld(t, old) {
  const page = await chrome.page(t);
  await page.init(helpers);
  const fixture = deployed(old);
  for (const [path, body] of Object.entries(fixture)) chrome.overrides.set(path, body);
  t.after(() => {
    for (const path of Object.keys(fixture)) chrome.overrides.delete(path);
  });
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await page.within(
    AGENT_BUDGET,
    async (old, lock) =>
      (await window.installedAgent()) === old &&
      (await window.readOpfs('/var/lib/slicc/agent/pnpm-lock.yaml')) === lock,
    old,
    fixture['/packages/agent/pnpm-lock.yaml']
  );
  const owner = await page.evaluate(() =>
    window.readOpfs('/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/owner.js')
  );
  for (const path of Object.keys(fixture)) chrome.overrides.delete(path);
  return { page, owner };
}

async function say(page, text, times) {
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => {
    const chat = window.chatView();
    return !!chat?.shadowRoot && !!window.deep(chat.shadowRoot, 'textarea');
  });
  await page.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
  await page.insert(text);
  await page.enter();
  await page.until(
    (times) =>
      window.deepText(window.chatView().shadowRoot).split('Hello from the agent.').length > times,
    times
  );
}

async function installs(page, old) {
  const seen = await page.evaluate(() => window.agentRows);
  const installing = seen.filter(({ state }) =>
    ['checking', 'downloading', 'linking'].includes(state)
  );
  assert.ok(installing.length > 0, JSON.stringify(seen));
  assert.ok(
    installing.some(({ from, to }) => from === old && to === NEW_VERSION),
    JSON.stringify(seen)
  );
  const started = installing[0].at;
  const done = seen.find(
    ({ state, at }) => at > started && !['checking', 'downloading', 'linking'].includes(state)
  );
  return { started, done: done?.at ?? null, seen };
}

async function oneHolder(page) {
  const locks = await page.evaluate(async () => {
    const { held, pending } = await navigator.locks.query();
    return {
      held: held.filter(({ name }) => name === 'slicc-agent').length,
      pending: pending.filter(({ name }) => name === 'slicc-agent').length,
    };
  });
  assert.deepEqual(locks, { held: 1, pending: 0 });
}

test("slicc-agent 3.26.0, which ignores held, isn't started at boot: seven's agent installs, the chat says it's updating meanwhile, and the new agent's chat starts without a reload", {
  timeout: 60 * 60 * 1000,
}, async (t) => {
  const { page, owner } = await installedOld(t, '3.26.0');
  assert.match(owner, /const release = await holdLock\(/);
  assert.doesNotMatch(owner, /options\.held/);
  const reloaded = Date.now();
  await page.reload();
  await ready(page);
  await page.within(AGENT_BUDGET, () =>
    ['downloading', 'linking'].includes(
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'agent').state
    )
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => !!window.chatView()?.shadowRoot && !!window.installNotice());
  const notice = await page.evaluate(() => window.installNotice());
  assert.equal(notice.title, 'Seven is updating its agent');
  assert.equal(notice.body, `The chat starts once agent ${NEW_VERSION} is installed.`);
  assert.deepEqual(notice.actions, [{ id: 'show-updates', label: 'Open Install / Update' }]);
  const shown = await page.until(() => {
    const root = window.chatView().shadowRoot;
    const text = window.deepText(root);
    return (
      text.includes('Seven is updating its agent') &&
      !window.deep(root, 'slicc-composer') &&
      window.deep(root, '[data-follow="watch"]')?.textContent.trim() ===
        'You can send messages once the agent starts.' &&
      text
    );
  });
  assert.doesNotMatch(shown, /Couldn|failed|error|Ask the agent something/i);
  await shoot(page, 'updating-from-3.26.0', { show: 'chat' });
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  assert.equal(
    await page.evaluate(
      () => document.querySelector('slicc-app').dock.api.getPanel('updates')?.api.isVisible ?? false
    ),
    false
  );
  await page.evaluate(() =>
    window
      .deep(
        window.chatView().shadowRoot,
        '[data-notice^="agent:installing:"] [data-action="show-updates"]'
      )
      .click()
  );
  await page.until(
    () => document.querySelector('slicc-app').dock.api.getPanel('updates')?.api.isVisible
  );
  const other = await page.tab();
  await other.init(helpers);
  await other.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(other);
  await other.until(
    () => document.querySelector('slicc-app').model.tabs?.state().role === 'follower'
  );
  await other.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await other.until(() => {
    const root = window.chatView()?.shadowRoot;
    return (
      !!root &&
      !window.deep(root, 'slicc-composer') &&
      window.deep(root, '[data-follow="watch"]')?.textContent.trim() ===
        'You can send messages once the agent starts.'
    );
  });

  await agentUp(page, { label: 'agent after 3.26.0' });
  const up = Date.now();
  const follower = await other.within(60000, () => {
    const root = window.chatView()?.shadowRoot;
    if (!root) return false;
    if (window.deep(root, 'textarea')) return 'composer';
    return !!window.deep(root, '[data-tabs-notice="skew"]') && 'skew';
  });
  if (follower === 'skew') {
    await other.reload();
    await ready(other);
    await other.evaluate(() => document.querySelector('slicc-app').show('chat'));
    await other.within(60000, () => {
      const root = window.chatView()?.shadowRoot;
      return !!root && !!window.deep(root, 'textarea');
    });
  }
  t.diagnostic(`the follower tab after the install: ${follower}`);
  const row = await page.evaluate(agentRow);
  assert.equal(await page.evaluate(() => window.installedAgent()), NEW_VERSION);
  assert.equal(row.state, 'installed');
  assert.deepEqual([row.from, row.to], [NEW_VERSION, NEW_VERSION]);
  const { started, done } = await installs(page, '3.26.0');
  await oneHolder(page);
  await page.until(() => window.installNotice() === null);
  t.diagnostic(
    `agent 3.26.0 → ${NEW_VERSION}: the chat waited ${up - reloaded} ms after the reload, the install took ${(done ?? up) - started} ms`
  );
  await connectAccount(page, 'amazon-bedrock', KEY);
  await say(page, 'Say hello', 1);
  assert.equal(
    await page.evaluate(() => window.deep(window.chatView().shadowRoot, '[data-follow="watch"]')),
    null
  );
  assert.deepEqual(page.errors, []);
  assert.deepEqual(other.errors, []);
});

test("slicc-agent 5.0.3, which honours held, answers while seven's agent installs in place, without the updating notice, and Restart agent puts the chat on the new agent without a reload", {
  timeout: 60 * 60 * 1000,
}, async (t) => {
  const { page, owner } = await installedOld(t, '5.0.3');
  assert.match(owner, /options\.held/);
  const reloaded = Date.now();
  await page.reload();
  await ready(page);
  await agentUp(page, { label: 'agent 5.0.3 after the reload' });
  const up = Date.now();
  await connectAccount(page, 'amazon-bedrock', KEY);
  await say(page, 'Say hello', 1);
  const answered = Date.now();
  const during = await page.evaluate(agentRow);
  await page.within(AGENT_BUDGET, () => {
    const row = document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent');
    return row.state === 'ready' && row.actions.includes('restart-agent');
  });
  const offered = Date.now();
  const offer = await page.evaluate(agentRow);
  assert.deepEqual([offer.from, offer.to], ['5.0.3', NEW_VERSION]);
  const { started, done } = await installs(page, '5.0.3');
  assert.ok(
    answered < (done ?? offered),
    `the old agent answered at ${answered}, the install ended at ${done}`
  );
  assert.equal(await page.evaluate(() => window.noticeSeen), false);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.updates.act('agent', 'restart-agent')
  );
  await page.within(
    AGENT_BUDGET,
    (version) => {
      const row = document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'agent');
      return row.state === 'current' && row.from === version && row.to === version;
    },
    NEW_VERSION
  );
  const restarted = Date.now();
  await oneHolder(page);
  await say(page, 'Say hello again', 2);
  assert.equal(await page.evaluate(() => window.noticeSeen), false);
  t.diagnostic(
    `agent 5.0.3 → ${NEW_VERSION} in place: the old agent was up ${up - reloaded} ms after the reload (row ${during.state} when it answered), the install took ${(done ?? offered) - started} ms, Restart agent was offered ${offered - reloaded} ms after the reload and took ${restarted - offered} ms`
  );
  assert.deepEqual(page.errors, []);
});
