import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { AGENT_BUDGET, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeLlm } from './fake-llm.mjs';

export const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const deployed = (version) =>
  Object.fromEntries(
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((file) => [
      `/packages/agent/${file}`,
      readFileSync(new URL(`fixtures/agent-${version}/${file}`, import.meta.url), 'utf8'),
    ])
  );
export const NEW_VERSION = JSON.parse(
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

export const chrome = await launch({ intercept: [], agent: true, timeout: 60000 });
export const llm = await fakeLlm(chrome.cdp, {
  hosts: [BEDROCK, 'https://registry.npmjs.org/'],
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
  await llm.close();
  await chrome.close();
});

export const helpers = () => {
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
  window.composer = () => {
    const root = window.chatView()?.shadowRoot;
    const composer = root && window.deep(root, 'slicc-composer');
    if (!composer) return null;
    return {
      placeholder: window
        .deep(composer.shadowRoot, 'swc-prompt-field')
        ?.getAttribute('placeholder'),
      queued: [...composer.shadowRoot.querySelectorAll('li.queued[data-mode="starting"]')].map(
        (row) => row.textContent.replace(/\s+/g, ' ').trim()
      ),
      empty: !!window.deep(root, '[data-empty]'),
    };
  };
  window.delivered = () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return id ? [...window.userTexts(), ...agent.queue(id).map((item) => item.text)] : [];
  };
  window.userTexts = () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return id
      ? agent
          .messages(id)
          .filter((message) => message.role === 'user')
          .map((message) => message.text)
      : [];
  };
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
      const row = updates.list().find((item) => item.id === 'agent');
      if (!row) return;
      const { state, from, to } = row;
      const last = window.agentRows.at(-1);
      if (last?.state !== state || last?.from !== from || last?.to !== to)
        window.agentRows.push({ state, from, to, at: Date.now() });
    };
    note();
    updates.on('items', note);
  };
  watch();
};

export const agentRow = () =>
  document
    .querySelector('slicc-app')
    .model.updates.list()
    .find((item) => item.id === 'agent');

export async function installedOld(t, old) {
  const page = await chrome.page(t);
  await page.init(helpers);
  const fixture = deployed(old);
  for (const [path, body] of Object.entries(fixture)) chrome.overrides.set(path, body);
  t.after(() => {
    for (const path of Object.keys(fixture)) chrome.overrides.delete(path);
  });
  await page.goto('/');
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

export async function queue(page, text) {
  const before = await page.evaluate(() => window.composer().queued.length);
  await page.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
  await page.insert(text);
  await page.enter();
  await page.until((before) => window.composer()?.queued.length === before + 1, before);
}

export async function say(page, text) {
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => {
    const chat = window.chatView();
    return !!chat?.shadowRoot && !!window.deep(chat.shadowRoot, 'textarea');
  });
  const answers = () =>
    window.deepText(window.chatView().shadowRoot).split('Hello from the agent.').length;
  const before = await page.evaluate(answers);
  await page.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
  await page.insert(text);
  await page.enter();
  await page.until(
    (before) =>
      window.deepText(window.chatView().shadowRoot).split('Hello from the agent.').length > before,
    before
  );
}

export async function installs(page, old) {
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

export async function oneHolder(page) {
  const locks = await page.evaluate(async () => {
    const { held, pending } = await navigator.locks.query();
    return {
      held: held.filter(({ name }) => name === 'slicc-agent').length,
      pending: pending.filter(({ name }) => name === 'slicc-agent').length,
    };
  });
  assert.deepEqual(locks, { held: 1, pending: 0 });
}
