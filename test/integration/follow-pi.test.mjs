import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { model, startHub } from './fake-hub.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';
import { shoot } from './shots.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';
const INSTALL = 15 * 60 * 1000;
const reply = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the owner.' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    metrics: { latencyMs: 1 },
  }),
]);

const looking = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', {
    contentBlockIndex: 0,
    delta: { text: 'Let me look around this SLICC first.' },
  }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('contentBlockStart', {
    contentBlockIndex: 1,
    start: { toolUse: { toolUseId: 'look-1', name: 'bash' } },
  }),
  eventFrame('contentBlockDelta', {
    contentBlockIndex: 1,
    delta: { toolUse: { input: JSON.stringify({ command: 'ls /' }) } },
  }),
  eventFrame('contentBlockStop', { contentBlockIndex: 1 }),
  eventFrame('messageStop', { stopReason: 'tool_use' }),
  eventFrame('metadata', {
    usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12 },
    metrics: { latencyMs: 1 },
  }),
]);
let release = null;
const held = new Promise((resolve) => {
  release = resolve;
});
let holding = false;
const lastTurn = (body) => {
  try {
    const sent = JSON.parse(body.toString());
    return {
      tools: !!sent.toolConfig?.tools?.length,
      content: sent.messages?.at(-1)?.content ?? [],
    };
  } catch {
    return { tools: false, content: [] };
  }
};

const owners = await launch({ agent: true, timeout: 60000 });
const followers = await launch({ agent: true, timeout: 60000 });
const asked = [];
const proxy = await fakeProxy({
  origin: new URL(owners.url).origin,
  key: 'the-key',
  answer: async (request, body) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    if (!request.url.startsWith(BEDROCK))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    asked.push(body.toString());
    const turn = lastTurn(body);
    if (turn.tools && turn.content.some((item) => item.text?.includes('Say hello')))
      return {
        status: 200,
        headers: [['content-type', 'application/vnd.amazon.eventstream']],
        body: looking,
      };
    if (turn.content.some((item) => item.toolResult) && !holding) {
      holding = true;
      await held;
    }
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: reply,
    };
  },
});
after(async () => {
  await proxy.close();
  await Promise.all([owners.close(), followers.close()]);
});

const dialog = () => {
  const deep = (root) => {
    const found = root.querySelector('slicc-confirm');
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && deep(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return deep(document)?.shadowRoot?.querySelector('dialog[open]') ?? null;
};

const said = (page) =>
  page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent ? JSON.stringify(agent.messages(agent.active())) : '';
  });

test('a follower watches the owner run with View, is refused a send, and sends with Control', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const owner = await owners.page(t);
  await owner.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(owner);
  await owner.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await owner.reload();
  await ready(owner);
  await owner.within(INSTALL, () =>
    document
      .querySelector('slicc-app')
      .model.settings?.accounts?.()
      .some((a) => a.id === 'amazon-bedrock')
  );
  await owner.evaluate(
    (secret) =>
      document.querySelector('slicc-app').model.settings.connect('amazon-bedrock', secret),
    KEY
  );
  const { joinUrl } = await model(owner, (network) => network.status().links);

  const page = await followers.page(t);
  await page.goto(`/#follow=${encodeURIComponent(joinUrl)}`);
  await page.until(new Function(`return !!(${dialog})()`));
  await page.evaluate(
    new Function(
      `[...(${dialog})().getRootNode().host.shadowRoot.querySelectorAll('swc-button')].find((b) => b.textContent.trim() === 'Follow').click()`
    )
  );
  await page.until(
    () => document.querySelector('slicc-app')?.model?.follow?.state().link === 'connected'
  );
  await owner.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.some((d) => d.kind === 'seven' && d.asking)
  );
  const [device] = await model(owner, (network) => network.status().links.devices);
  await model(owner, (network, id) => network.setAccess(id, 'view', true), device.id);
  await owner.within(INSTALL, () =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .links.devices.some((d) => d.controlling === 'watch')
  );

  await owner.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    void agent.send(agent.active(), 'Say hello');
  });
  for (let i = 0; i < 600 && !holding; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(holding, 'the owner agent never ran its tool');
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    const said = JSON.stringify(agent.messages(agent.active()));
    return said.includes('look around this SLICC') && agent.busy(agent.active());
  });
  await shoot(page, 'follower-chat-mid-answer', { show: 'chat' });
  release();
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active())).includes('Hello from the owner.');
  });
  assert.match(await said(page), /Say hello/);
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return !agent.busy(agent.active());
  });
  await shoot(page, 'follower-chat-answered', { show: 'chat' });
  await shoot(owner, 'owner-watching', { show: 'network', target: '[aria-labelledby="links"]' });

  const refused = await page.evaluate(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent.send(agent.active(), 'From a watcher').then(
      () => 'sent',
      (error) => error.message
    );
  });
  assert.match(refused, /EACCES|watch, but not send/);
  assert.ok(!asked.some((body) => body.includes('From a watcher')));
  assert.doesNotMatch(await said(owner), /From a watcher/);

  await model(owner, (network, id) => network.setAccess(id, 'control', true), device.id);
  await page.until(() => {
    const app = document.querySelector('slicc-app');
    return app.model.follow.state().access.control && !!app.model.agent;
  });
  await page.until(async () => {
    const { agent } = document.querySelector('slicc-app').model;
    return agent.send(agent.active(), 'From the follower').then(
      () => true,
      () => false
    );
  });
  await owner.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return JSON.stringify(agent.messages(agent.active())).includes('From the follower');
  });
  await owner.until(
    () =>
      !document
        .querySelector('slicc-app')
        .model.agent.busy(document.querySelector('slicc-app').model.agent.active())
  );
  assert.ok(asked.some((body) => body.includes('From the follower')));
  assert.deepEqual(owner.errors, []);
  assert.deepEqual(page.errors, []);
  await owner.evaluate(() => localStorage.removeItem('slicc-os.tray-hub'));
});
