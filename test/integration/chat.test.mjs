import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';

const KEY = 'dummy-bedrock-key-0000';
const BEDROCK = 'https://bedrock-runtime.us-west-2.amazonaws.com/';

const stream = Buffer.concat([
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Bedrock in seven.' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', {
    usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    metrics: { latencyMs: 1 },
  }),
]);

const chrome = await launch({ agent: true, timeout: 1200000 });
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
  key: 'the-key',
  answer: async (request) => {
    if (request.url.startsWith('https://registry.npmjs.org/')) {
      const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
      return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
    }
    const authorization = request.headers.find(([name]) => name.toLowerCase() === 'authorization');
    if (!request.url.startsWith(BEDROCK) || authorization?.[1] !== `Bearer ${KEY}`) {
      return {
        status: 403,
        headers: [
          ['content-type', 'application/json'],
          ['x-amzn-errortype', 'UnrecognizedClientException'],
        ],
        body: Buffer.from('{"message":"The security token included in the request is invalid."}'),
      };
    }
    return {
      status: 200,
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: stream,
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
};

test('chat in seven answers through the agent worker, Bedrock and the local proxy', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await page.until(() =>
    /installing the agent… \d+\/\d+/.test(document.querySelector('.agent').textContent)
  );
  await page.screenshot(new URL('installing.png', page.dir));
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.settings.accounts()
      .some((account) => account.id === 'amazon-bedrock')
  );
  const account = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.settings.accounts()
      .find((item) => item.id === 'amazon-bedrock')
  );
  assert.equal(account.status, 'disconnected');
  assert.equal(account.needs, 'cors-free-transport');

  const connect = (key) =>
    page.evaluate(
      (secret) =>
        document.querySelector('slicc-app').model.settings.connect('amazon-bedrock', secret),
      key
    );
  const sendChat = async (text) => {
    await page.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
    await page.insert(text);
    await page.enter();
  };
  await connect('dummy-wrong-key');
  await page.until(() =>
    document.querySelector('slicc-app').dock.api.panels.some((panel) => panel.id === 'chat:cone')
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  await sendChat('Say hello');
  await page.until(() => !!window.deep(window.chatView().shadowRoot, '.error-card'));
  assert.match(
    await page.evaluate(() =>
      window.deepText(window.deep(window.chatView().shadowRoot, '.error-card'))
    ),
    /Bedrock rejected the API key\.[\s\S]*security token included in the request is invalid[\s\S]*Open settings/
  );
  await page.screenshot(new URL('error-card.png', page.dir));
  await connect(KEY);
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.settings.accounts()
        .find((item) => item.id === 'amazon-bedrock').status === 'connected'
  );

  await page.until(() =>
    document.querySelector('slicc-app').dock.api.panels.some((panel) => panel.id === 'chat:cone')
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  assert.deepEqual(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .dock.api.panels.map((panel) => panel.id)
        .filter((id) => id === 'chat' || id.startsWith('chat:'))
    ),
    ['chat:cone']
  );
  await page.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
  await page.insert('Say hello');
  await page.enter();
  await page.until(() =>
    window.deepText(window.chatView().shadowRoot).includes('Hello from Bedrock in seven.')
  );
  await page.screenshot(new URL('chat.png', page.dir));

  const keyed = () =>
    proxy.requests.filter(
      (request) =>
        request.url.startsWith(BEDROCK) &&
        request.headers.some(
          ([name, value]) => name.toLowerCase() === 'authorization' && value === `Bearer ${KEY}`
        )
    );
  const sent = keyed();
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/model\/us\.anthropic\.claude-sonnet-5-5\/converse-stream$/);
  assert.equal(sent[0].method, 'POST');
  assert.match(sent[0].body, /Say hello/);
  assert.equal(await page.evaluate(() => document.querySelector('.agent').hidden), true);

  const lock = await readFile(
    new URL('../../src/packages/agent/pnpm-lock.yaml', import.meta.url),
    'utf8'
  );
  chrome.overrides.set('/packages/agent/pnpm-lock.yaml', `${lock}# updated\n`);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.until(() => document.querySelector('.agent').dataset.state === 'ready');
  assert.deepEqual(
    await page.evaluate(() => {
      const notice = document.querySelector('.agent');
      return [notice.querySelector('output').value, notice.querySelector('button').textContent];
    }),
    ['agent updated', 'Restart agent']
  );
  await page.screenshot(new URL('restart.png', page.dir));
  await page.evaluate(() => document.querySelector('.agent button').click());
  await page.until(() => document.querySelector('.agent').hidden);
  await page.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  await sendChat('Say hello again');
  await page.until(
    () =>
      window.deepText(window.chatView().shadowRoot).split('Hello from Bedrock in seven.').length ===
      3
  );
  assert.equal(keyed().length, 2);
  assert.deepEqual(page.errors, []);
});
