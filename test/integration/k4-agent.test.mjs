import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { connectAccount, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const INSTALL = 15 * 60 * 1000;

const usage = eventFrame('metadata', {
  usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
  metrics: { latencyMs: 1 },
});
const text = (said) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: said } }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'end_turn' }),
    usage,
  ]);
const bash = (id, command) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockStart', {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: id, name: 'bash' } },
    }),
    eventFrame('contentBlockDelta', {
      contentBlockIndex: 0,
      delta: { toolUse: { input: JSON.stringify({ command }) } },
    }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'tool_use' }),
    usage,
  ]);

function answer(body) {
  let sent = {};
  try {
    sent = JSON.parse(body.toString());
  } catch {}
  const content = sent.messages?.at(-1)?.content ?? [];
  const said = content.map((item) => item.text ?? '').join(' ');
  const result = content.find((item) => item.toolResult)?.toolResult?.toolUseId;
  if (result === 'sudo-1') return text('Seven said no, so I left /root alone.');
  if (result === 'rules-1') return text('Seven said no, so the secret rules are unchanged.');
  if (sent.toolConfig?.tools?.length && said.includes('Change the rules'))
    return bash('rules-1', 'echo allow = true | sudo tee /etc/fnox/config.toml');
  if (sent.toolConfig?.tools?.length && said.includes('List root'))
    return bash('sudo-1', 'whoami; sudo ls -la /root');
  return text('Done.');
}

const chrome = await launch({ agent: true, timeout: 60000 });
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
  key: 'the-key',
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: answer(body),
    };
  },
});
after(async () => {
  await proxy.close();
  await chrome.close();
});

const find = (selector) => {
  const walk = (root) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && walk(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return walk(document);
};

async function click(page, id, decision) {
  await page.until(
    new Function(
      'id',
      'decision',
      `const list = document.querySelector('slicc-app').model.approvals.list();
      if (!list.some((item) => item.id === id)) return true;
      (${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog[data-approval="' + id + '"] [data-action="' + decision + '"]')?.click();
      return false;`
    ),
    id,
    decision
  );
}

async function shots(page, name) {
  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await shade(page, 'light');
  await page.screenshot(new URL(`${name}-light.png`, page.dir));
  await shade(page, 'dark');
  await page.screenshot(new URL(`${name}-dark.png`, page.dir));
  await shade(page, 'light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await new Promise((resolve) => setTimeout(resolve, 800));
  await page.screenshot(new URL(`${name}-420.png`, page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
}

const shade = (page, value) =>
  page.evaluate((value) => {
    const app = document.querySelector('slicc-app');
    if (app.color !== value) app.toggleColor();
  }, value);

test('enforce: a cone agent’s sudo asks the human, naming the agent, and Deny refuses it', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto(
    `/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key', users: 'enforce' })}`
  );
  await ready(page, ['slicc:/home# ']);
  await page.within(INSTALL, () =>
    document
      .querySelector('slicc-app')
      .model.settings?.accounts?.()
      .some((a) => a.id === 'amazon-bedrock')
  );
  await connectAccount(page, 'amazon-bedrock', KEY);
  await page.evaluate(() => {
    const { notices } = document.querySelector('slicc-app').model;
    for (const notice of notices.list()) notices.dismiss(notice.id);
    const { agent } = document.querySelector('slicc-app').model;
    document.querySelector('slicc-app').show('chat');
    void agent.send(agent.active(), 'List root’s home');
  });
  const [asked] = await page.within(5 * 60 * 1000, () => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  assert.equal(asked.kind, 'sudo');
  assert.equal(asked.command, '/usr/bin/ls -la /root');
  assert.deepEqual(asked.requester, { kind: 'agent', name: 'cone', agentId: 'cone:cone' });
  assert.equal(asked.target, 'root');
  assert.equal(asked.cwd, '/home/cone');
  await page.until(
    new Function(
      'id',
      `return !!(${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog[data-approval="' + id + '"]')`
    ),
    asked.id
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await shots(page, 'agent-sudo');
  await click(page, asked.id, 'deny');
  await page.within(5 * 60 * 1000, () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id) && JSON.stringify(agent.messages(id)).includes('left /root alone');
  });
  const output = await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active()));
  });
  assert.match(output, /approval denied/);
  assert.match(output, /\bcone\b/);

  await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Change the rules');
  });
  const [rules] = await page.within(5 * 60 * 1000, () => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  assert.equal(rules.command, '/usr/bin/tee /etc/fnox/config.toml');
  assert.equal(rules.always, false);
  const buttons = await page.until(
    new Function(
      'id',
      `const dialog = (${find})('slicc-approvals')?.shadowRoot?.querySelector('dialog[data-approval="' + id + '"]');
      return dialog?.querySelector('[data-secret-rules]') && [...dialog.querySelectorAll('[data-action]')].map((b) => b.dataset.action);`
    ),
    rules.id
  );
  assert.deepEqual(buttons.sort(), ['deny', 'once']);
  await shots(page, 'agent-secret-rules');
  await page.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'always'),
    rules.id
  );
  await page.within(5 * 60 * 1000, () => {
    const { agent } = document.querySelector('slicc-app').model;
    const id = agent.active();
    return !agent.busy(id);
  });
  assert.doesNotMatch(
    await page.evaluate(async () => {
      let dir = await navigator.storage.getDirectory();
      try {
        for (const part of ['etc', 'sudoers.d']) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle('cone')).getFile()).text();
      } catch {
        return '';
      }
    }),
    /fnox/
  );
  assert.deepEqual(page.errors, []);
});
