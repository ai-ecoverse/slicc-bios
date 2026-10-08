import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { eventFrame, fakeProxy } from './fake-proxy.mjs';

const KEY = 'dummy-bedrock-key-0000';
const ADOBE = 'https://adobe-llm-proxy.paolo-moz.workers.dev/';
const ADOBE_TOKEN = 'dummy-adobe-token-0000';
const adobeConfig = {
  clientId: 'test-client',
  scopes: 'openid,AdobeID',
  imsEnvironment: 'prod',
  models: [{ id: 'claude-test', name: 'Claude Test', context_window: 200000, max_tokens: 8192 }],
};
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

const certs = mkdtempSync(join(tmpdir(), 'ims-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=ims-na1.adobelogin.com',
    '-keyout',
    join(certs, 'key.pem'),
    '-out',
    join(certs, 'cert.pem'),
  ],
  { stdio: 'ignore' }
);
const authorized = [];
let hold = true;
const ims = createServer(
  { key: readFileSync(join(certs, 'key.pem')), cert: readFileSync(join(certs, 'cert.pem')) },
  (req, res) => {
    const url = new URL(req.url, 'https://ims-na1.adobelogin.com');
    if (url.pathname === '/ims/authorize/v2') authorized.push(Object.fromEntries(url.searchParams));
    const state = JSON.parse(
      Buffer.from(url.searchParams.get('state') ?? 'e30=', 'base64').toString()
    );
    const back =
      state.source === 'origin'
        ? `${state.origin}/auth/callback`
        : `http://localhost:${state.port}${state.path}`;
    const target = `${back}?nonce=${state.nonce}#access_token=${ADOBE_TOKEN}&expires_in=86400`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      hold ? 'Sign in to Adobe' : `<script>location.replace(${JSON.stringify(target)});</script>`
    );
  }
);
await new Promise((resolve) => ims.listen(0, '127.0.0.1', resolve));
const chrome = await launch({
  agent: true,
  timeout: 60000,
  args: [
    `--host-resolver-rules=MAP ims-na1.adobelogin.com:443 127.0.0.1:${ims.address().port}`,
    '--ignore-certificate-errors',
  ],
});
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
  key: 'the-key',
  answer: async (request) => {
    if (request.url.startsWith(ADOBE)) {
      const bearer = request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
      const body = request.url.endsWith('/v1/config')
        ? adobeConfig
        : bearer === `Bearer ${ADOBE_TOKEN}`
          ? { usage: { weekly: { status: 'ok', percent: 42, resetsAt: '2026-10-15T00:00:00Z' } } }
          : { error: 'unauthorized' };
      return {
        status: body.error ? 401 : 200,
        headers: [['content-type', 'application/json']],
        body: Buffer.from(JSON.stringify(body)),
      };
    }
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
  ims.close();
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

const INSTALL = 15 * 60 * 1000;

async function eventually(check, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`still false after ${ms} ms: ${check}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const UPDATE = 5 * 60 * 1000;

test('chat in seven answers through the agent worker, Bedrock and the local proxy', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await page.until(() =>
    /installing the agent… \d+\/\d+/.test(document.querySelector('.agent').textContent)
  );
  await page.screenshot(new URL('installing.png', page.dir));
  await page.within(INSTALL, () =>
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
  await page.within(UPDATE, () => document.querySelector('.agent').dataset.state === 'ready');
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

  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.evaluate(() => {
    window.adobeButton = () =>
      window.deep(
        document.querySelector('slicc-app').dock.content('settings').shadowRoot,
        '.account[data-id=adobe] sp-button'
      );
  });
  const signIn = async () => {
    await page.until(() => !!window.adobeButton() && !window.adobeButton().disabled);
    await page.evaluate(() => window.adobeButton().focus());
    await page.press('Enter');
  };
  await signIn();
  await page.until(() => !document.querySelector('.sign-in').hidden);
  assert.equal(
    await page.evaluate(() => document.querySelector('.sign-in output').value),
    'signing in to Adobe…'
  );
  await page.screenshot(new URL('signing-in.png', page.dir));
  await page.evaluate(() => document.querySelector('.sign-in button').click());
  await page.until(() => document.querySelector('.sign-in').hidden);
  await eventually(() => proxy.dropped.length === 1 && authorized.length === 1);
  hold = false;
  authorized.length = 0;
  await page.evaluate(() => localStorage.setItem('slicc-os.sign-in', 'relay'));
  await signIn();
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.settings.accounts()
        .find((item) => item.id === 'adobe')?.status === 'connected'
  );
  const [authorize] = authorized;
  assert.equal(authorize.client_id, 'test-client');
  assert.equal(authorize.redirect_uri, 'https://www.sliccy.ai/auth/callback');
  assert.equal(authorize.response_type, 'token');
  assert.deepEqual(JSON.parse(Buffer.from(authorize.state, 'base64').toString()), {
    source: 'origin',
    origin: new URL(chrome.url).origin,
    nonce: JSON.parse(Buffer.from(authorize.state, 'base64').toString()).nonce,
  });
  assert.equal(authorize.scope, 'openid,AdobeID');
  await page.until(
    () => document.querySelector('slicc-app').model.tray.status().budget.percent === 42
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.settings.models()
      .some((option) => option.id === 'adobe/claude-test')
  );
  await page.screenshot(new URL('adobe.png', page.dir));
  assert.ok(
    !(await page.evaluate(
      (token) => document.documentElement.outerHTML.includes(token),
      ADOBE_TOKEN
    ))
  );
  assert.deepEqual(page.errors, []);
});
