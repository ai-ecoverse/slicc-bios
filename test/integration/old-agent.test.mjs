import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentUp, connectAccount, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const OLD_VERSION = '3.26.0';
const OLD = new URL(`fixtures/agent-${OLD_VERSION}/`, import.meta.url);
const OLD_AGENT = Object.fromEntries(
  ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((file) => [
    `/packages/agent/${file}`,
    readFileSync(new URL(file, OLD), 'utf8'),
  ])
);
const NEW_VERSION = JSON.parse(
  readFileSync(new URL('../../src/packages/agent/package.json', import.meta.url), 'utf8')
).dependencies['@ai-ecoverse/slicc-agent'];
const INSTALL = 10 * 60 * 1000;

const answer = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the new agent.' } }),
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
    const id = dock.api.panels.map((panel) => panel.id).find((panel) => panel.startsWith('chat:'));
    return id ? dock.content(id) : null;
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
  const watch = () => {
    const updates = document.querySelector('slicc-app')?.model?.updates;
    if (!updates?.on) return setTimeout(watch, 20);
    const note = () => {
      const { state, from, to } = updates.list().find((item) => item.id === 'agent');
      const last = window.agentRows.at(-1);
      if (last?.state !== state || last?.from !== from || last?.to !== to)
        window.agentRows.push({ state, from, to });
    };
    note();
    updates.on('items', note);
  };
  watch();
};

test(`a profile whose /opt/agent holds slicc-agent ${OLD_VERSION}, which takes the slicc-agent lock itself and ignores held, updates to seven's agent and starts its chat without a reload, and the row shows ${OLD_VERSION} → the new version while it installs`, {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  for (const [path, body] of Object.entries(OLD_AGENT)) chrome.overrides.set(path, body);
  t.after(() => {
    for (const path of Object.keys(OLD_AGENT)) chrome.overrides.delete(path);
  });
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  const oldLock = OLD_AGENT['/packages/agent/pnpm-lock.yaml'];
  await page.within(
    INSTALL,
    async (lock) =>
      (await window.installedAgent()) === '3.26.0' &&
      (await window.readOpfs('/var/lib/slicc/agent/pnpm-lock.yaml')) === lock,
    oldLock
  );
  const owner = await page.evaluate(() =>
    window.readOpfs('/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/owner.js')
  );
  assert.match(owner, /const release = await holdLock\(/);
  assert.doesNotMatch(owner, /options\.held/);

  for (const path of Object.keys(OLD_AGENT)) chrome.overrides.delete(path);
  await page.reload();
  await ready(page);
  await agentUp(page, { label: `agent after ${OLD_VERSION}` });
  const row = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent')
  );
  const seen = await page.evaluate(() => window.agentRows);
  assert.equal(await page.evaluate(() => window.installedAgent()), NEW_VERSION);
  assert.equal(row.state, 'installed', JSON.stringify(seen));
  assert.deepEqual([row.from, row.to], [NEW_VERSION, NEW_VERSION], JSON.stringify(seen));
  const installing = seen.filter(({ state }) =>
    ['checking', 'downloading', 'linking'].includes(state)
  );
  assert.ok(installing.length > 0, JSON.stringify(seen));
  assert.ok(
    installing.some(({ from, to }) => from === OLD_VERSION && to === NEW_VERSION),
    JSON.stringify(seen)
  );
  const locks = await page.evaluate(async () => {
    const { held, pending } = await navigator.locks.query();
    return {
      held: held.filter(({ name }) => name === 'slicc-agent').length,
      pending: pending.filter(({ name }) => name === 'slicc-agent').length,
    };
  });
  assert.deepEqual(locks, { held: 1, pending: 0 });

  await connectAccount(page, 'amazon-bedrock', KEY);
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  await page.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
  await page.insert('Say hello');
  await page.enter();
  await page.until(() =>
    window.deepText(window.chatView().shadowRoot).includes('Hello from the new agent.')
  );
  assert.deepEqual(page.errors, []);
});
