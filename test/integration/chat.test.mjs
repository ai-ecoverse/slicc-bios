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
  window.memoryView = () => document.querySelector('slicc-app').dock.content('memory');
  const folder = async (parts) => {
    let handle = await navigator.storage.getDirectory();
    for (const part of parts) handle = await handle.getDirectoryHandle(part, { create: true });
    return handle;
  };
  const fileOf = async (path) => {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    return (await folder(parts)).getFileHandle(name, { create: true });
  };
  window.writeFile = async (path, text) => {
    const writable = await (await fileOf(path)).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.readFile = async (path) => (await (await fileOf(path)).getFile()).text();
};

const storageStub = () => {
  let saved;
  try {
    saved = localStorage.getItem('test.storage');
  } catch {
    return;
  }
  const answers = JSON.parse(saved ?? '{"persisted":false,"persist":false}');
  window.storageAnswers = answers;
  window.persistCalls = Number(localStorage.getItem('test.persistCalls') ?? 0);
  navigator.storage.persisted = async () => answers.persisted;
  navigator.storage.persist = async () => {
    window.persistCalls += 1;
    localStorage.setItem('test.persistCalls', String(window.persistCalls));
    return answers.persist;
  };
  window.storageNotice = () => window.deep(window.chatView().shadowRoot, '[data-notice="storage"]');
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
const GLOBAL_MEMORY = '/home/.pi/agent/memory/MEMORY.md';
const CONE_MEMORY = '/home/.pi/agent/memory/cone/MEMORY.md';

test('chat in seven answers through the agent worker, Bedrock and the local proxy', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(storageStub);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await page.evaluate(
    (global, cone) =>
      Promise.all([
        window.writeFile(
          global,
          '## About the user\n\n### Name\ntag: user\n\nThe user is Sam, at Example Inc.\n\n## Preferences\n\n### Short replies\ntag: feedback\n\nSam likes short replies with the answer first.\n'
        ),
        window.writeFile(
          cone,
          '## Projects\n\nExample Inc. keeps its forecasts in a small API called harbor.\n\n### harbor releases\ntag: project\n\nharbor ships on Fridays, after the forecast tests pass.\n'
        ),
      ]),
    GLOBAL_MEMORY,
    CONE_MEMORY
  );
  await page.evaluate(() => {
    window.progress = [];
    window.agentRow = () =>
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'agent');
    window.updatesButton = (id, action) =>
      document
        .querySelector('slicc-app')
        .dock.content('updates')
        ?.shadowRoot?.querySelector(`article[data-id="${id}"] swc-button[data-action="${action}"]`);
    window.updatesOpen = () =>
      document.querySelector('slicc-app').dock.api.panels.some((panel) => panel.id === 'updates');
    document.querySelector('slicc-app').model.updates.on('items', () => {
      const { progress } = window.agentRow();
      if (progress) window.progress.push(progress);
      const { state } = window.agentRow();
      if (['checking', 'downloading', 'linking'].includes(state))
        window.installStart ??= performance.now();
      if (state === 'installed') window.installEnd ??= performance.now();
    });
  });
  await page.within(INSTALL, () => {
    const { state, progress } = window.agentRow();
    return (
      state === 'downloading' &&
      progress.done > 0 &&
      progress.total >= 10 &&
      window.updatesOpen() &&
      !document.querySelector('slicc-app').model.updates.ready()
    );
  });
  await page.until(
    () =>
      !!document
        .querySelector('slicc-app')
        .dock.content('updates')
        ?.shadowRoot?.querySelector('article[data-id="agent"] swc-progress-bar[value]')
  );
  await page.screenshot(new URL('installing.png', page.dir));
  await page.within(INSTALL, () =>
    document
      .querySelector('slicc-app')
      .model.settings.accounts()
      .some((account) => account.id === 'amazon-bedrock')
  );
  await page.until(() => !window.updatesOpen());
  assert.deepEqual(
    await page.evaluate(() => {
      const { state, actions } = window.agentRow();
      return [document.querySelector('slicc-app').model.updates.ready(), state, actions];
    }),
    [true, 'installed', []]
  );
  const measured = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const modules = await (
      await (await root.getDirectoryHandle('opt')).getDirectoryHandle('agent')
    ).getDirectoryHandle('node_modules');
    let bytes = 0;
    let packages = 0;
    const walk = async (dir, inModules) => {
      for await (const handle of dir.values()) {
        if (handle.kind !== 'directory') {
          bytes += (await handle.getFile()).size;
          continue;
        }
        if (inModules && !handle.name.startsWith('.') && !handle.name.startsWith('@'))
          packages += 1;
        const scope = inModules && handle.name.startsWith('@');
        await walk(handle, handle.name === 'node_modules' || scope);
      }
    };
    await walk(modules, true);
    return { ms: Math.round(window.installEnd - window.installStart), bytes, packages };
  });
  console.log(
    `agent install: ${measured.ms} ms, ${(measured.bytes / 1e6).toFixed(1)} MB in /opt/agent/node_modules, ${measured.packages} packages`
  );
  const phases = await page.evaluate(() => window.progress.map(({ phase }) => phase));
  const firstLink = phases.indexOf('link');
  assert.ok(firstLink > 0, JSON.stringify(phases.slice(-5)));
  assert.ok(phases.slice(0, firstLink).every((phase) => phase === 'download'));
  assert.ok(phases.slice(firstLink).every((phase) => phase === 'link'));
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
  const booted = await page.evaluate(() => window.persistCalls);
  await sendChat('Say hello');
  await page.until(() => !!window.storageNotice());
  assert.equal(await page.evaluate(() => window.persistCalls), booted + 1);
  const [notice] = await page.evaluate(() =>
    document.querySelector('slicc-app').model.notices.list()
  );
  assert.equal(notice.title, 'Seven’s files may be cleared');
  assert.match(
    notice.body,
    /^Chrome may clear seven’s files and chats when disk space runs low\. (Install seven as an app|Bookmark seven) to keep them\.$/
  );
  assert.equal(notice.actions.at(-1).id, 'retry');
  assert.deepEqual(
    notice.actions.map(({ id }) => id),
    notice.body.includes('Install') ? ['install', 'retry'] : ['retry']
  );
  await page.until(() => !!window.deep(window.chatView().shadowRoot, '.error-card'));
  await page.screenshot(new URL('storage-notice-bookmark-light.png', page.dir));
  await page.evaluate(() => {
    const offer = new Event('beforeinstallprompt', { cancelable: true });
    window.prompted = 0;
    offer.prompt = async () => {
      window.prompted += 1;
    };
    offer.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(offer);
  });
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .some((notice) => notice.actions[0]?.id === 'install')
  );
  assert.equal(
    (await page.evaluate(() => document.querySelector('slicc-app').model.notices.list()))[0].body,
    'Chrome may clear seven’s files and chats when disk space runs low. Install seven as an app to keep them.'
  );
  await page.until(() => !!window.deep(window.storageNotice(), '[data-action="install"]'));
  await page.screenshot(new URL('storage-notice-light.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('storage-notice-dark.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => !!window.chatView() && !!window.storageNotice());
  await page.screenshot(new URL('storage-notice-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => !!window.chatView() && !!window.storageNotice());
  await page.evaluate(() => window.deep(window.storageNotice(), '[data-action="install"]').click());
  await page.until(
    () =>
      window.prompted === 1 &&
      document.querySelector('slicc-app').model.notices.list()[0]?.actions.length === 1
  );
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.notices.act('storage', 'retry')
        .then(
          () => 'kept',
          (error) => error.message
        )
    ),
    'Chrome still doesn’t keep seven’s files. Install seven as an app or bookmark it, then try again.'
  );
  assert.ok(await page.evaluate(() => !!window.storageNotice()));
  await page.evaluate(() => {
    window.storageAnswers.persist = true;
    window.deep(window.storageNotice(), '[data-action="retry"]').click();
  });
  await page.until(() => !window.storageNotice());
  assert.deepEqual(
    await page.evaluate(() => document.querySelector('slicc-app').model.notices.list()),
    []
  );
  assert.equal(await page.evaluate(() => window.persistCalls), booted + 3);
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
  assert.equal(await page.evaluate(() => window.agentRow().state), 'installed');

  const lock = await readFile(
    new URL('../../src/packages/agent/pnpm-lock.yaml', import.meta.url),
    'utf8'
  );
  chrome.overrides.set('/packages/agent/pnpm-lock.yaml', `${lock}# updated\n`);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.within(UPDATE, () => window.agentRow().state === 'ready');
  assert.deepEqual(await page.evaluate(() => [window.agentRow().actions, window.updatesOpen()]), [
    ['restart-agent'],
    false,
  ]);
  await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
  await page.until(() => !!window.updatesButton('agent', 'restart-agent'));
  await page.screenshot(new URL('restart.png', page.dir));
  await page.evaluate(() => window.updatesButton('agent', 'restart-agent').click());
  await page.until(() => window.agentRow().state === 'current');
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  await sendChat('Say hello again');
  assert.equal(await page.evaluate(() => window.persistCalls), booted + 3);
  await page.until(
    () =>
      window.deepText(window.chatView().shadowRoot).split('Hello from Bedrock in seven.').length ===
      3
  );
  assert.equal(keyed().length, 2);

  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.evaluate(() => {
    window.adobeStatus = () =>
      document
        .querySelector('slicc-app')
        .model.settings.accounts()
        .find((item) => item.id === 'adobe')?.status;
    window.adobeCancel = () =>
      window.deep(
        document.querySelector('slicc-app').dock.content('settings').shadowRoot,
        '.account[data-id=adobe] [data-action=cancel-sign-in]'
      );
    window.adobeButton = () =>
      window.deep(
        document.querySelector('slicc-app').dock.content('settings').shadowRoot,
        '.account[data-id=adobe] [data-action=connect]'
      );
  });
  const signIn = async () => {
    await page.until(
      () =>
        !!window.adobeButton() &&
        !window.adobeButton().matches('[disabled], [pending], [aria-disabled=true]')
    );
    assert.equal(
      await page.evaluate(() => {
        window.adobeButton().focus();
        return window.adobeButton().matches(':focus-within');
      }),
      true
    );
    await page.press('Enter');
  };
  await signIn();
  await page.until(() => window.adobeStatus() === 'signing-in');
  await page.until(() => !!window.adobeCancel());
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('slicc-app > [slot="status"]').length),
    0
  );
  await page.screenshot(new URL('signing-in-light.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('signing-in-dark.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(() => !!window.adobeCancel());
  await page.evaluate(() => window.adobeCancel().scrollIntoView({ block: 'center' }));
  await page.screenshot(new URL('signing-in-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
  await page.until(() => !!window.adobeCancel());
  await page.evaluate(() => window.adobeCancel().click());
  await page.until(() => window.adobeStatus() === 'disconnected');
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

  await page.evaluate(() => document.querySelector('slicc-app').show('memory'));
  await page.until(() =>
    window
      .deepText(window.memoryView()?.shadowRoot ?? document)
      .includes('The user is Sam, at Example Inc.')
  );
  await page.evaluate(() => {
    const root = window.memoryView().shadowRoot;
    [...root.querySelectorAll('.bar swc-action-button')]
      .find((button) => button.textContent.includes('Remember'))
      .click();
  });
  await page.until(() => !!window.memoryView().shadowRoot.querySelector('.editor'));
  await page.evaluate(() => {
    const editor = window.memoryView().shadowRoot.querySelector('.editor');
    const fields = {
      title: 'Meetings',
      section: 'About the user',
      tag: 'user',
      body: 'Sam prefers meetings in the morning.',
    };
    for (const [name, value] of Object.entries(fields))
      editor.querySelector(`[name=${name}]`).value = value;
    [...editor.querySelectorAll('swc-button')]
      .find((button) => button.textContent.trim() === 'Save')
      .click();
  });
  await page.until(
    async (path) => (await window.readFile(path)).includes('### Meetings'),
    GLOBAL_MEMORY
  );
  assert.equal(
    await page.evaluate((path) => window.readFile(path), GLOBAL_MEMORY),
    '## About the user\n\n### Name\ntag: user\n\nThe user is Sam, at Example Inc.\n\n### Meetings\ntag: user\n\nSam prefers meetings in the morning.\n\n## Preferences\n\n### Short replies\ntag: feedback\n\nSam likes short replies with the answer first.\n'
  );
  const scope = (id) =>
    page.evaluate((value) => {
      const picker = window.memoryView().shadowRoot.querySelector('.tools sp-picker[label=Scope]');
      picker.value = value;
      picker.dispatchEvent(new Event('change'));
    }, id);
  const color = async (value) => {
    await page.evaluate((wanted) => {
      const app = document.querySelector('slicc-app');
      if (app.color !== wanted) app.toggleColor();
    }, value);
    await page.until(
      (wanted) =>
        document
          .querySelector('slicc-app')
          .shadowRoot.querySelector('.swc-theme')
          .classList.contains(`swc-theme--${wanted}`),
      value
    );
  };
  const shots = async (name) => {
    await page.screenshot(new URL(`memory-${name}-light.png`, page.dir));
    await color('dark');
    await page.screenshot(new URL(`memory-${name}-dark.png`, page.dir));
    await color('light');
  };
  const screen = async (value) => {
    await page.until((wanted) => document.querySelector('slicc-app').screen === wanted, value);
    await page.evaluate(() => {
      const app = document.querySelector('slicc-app');
      app.show('chat');
      app.show('memory');
    });
    await page.until(() => !!window.memoryView()?.shadowRoot.querySelector('.tools'));
  };
  await page.until(() =>
    window.deepText(window.memoryView().shadowRoot).includes('Sam prefers meetings in the morning.')
  );
  await color('light');
  await screen('desktop');
  await shots('global');
  await scope('cone');
  await page.until(() =>
    window.deepText(window.memoryView().shadowRoot).includes('harbor ships on Fridays')
  );
  await shots('cone');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await screen('phone');
  await scope('cone');
  await page.until(() =>
    window.deepText(window.memoryView().shadowRoot).includes('harbor ships on Fridays')
  );
  await page.screenshot(new URL('memory-cone-420.png', page.dir));
  await scope('global');
  await page.until(() =>
    window.deepText(window.memoryView().shadowRoot).includes('The user is Sam, at Example Inc.')
  );
  await page.screenshot(new URL('memory-global-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await screen('desktop');
  await scope('global');
  await page.until(
    () =>
      !!window
        .memoryView()
        .shadowRoot.querySelector('[data-id="global/about-the-user/meetings"] .head')
  );
  await page.evaluate(() =>
    window
      .memoryView()
      .shadowRoot.querySelector('[data-id="global/about-the-user/meetings"] .head')
      .click()
  );
  await page.until(
    () =>
      !!window
        .memoryView()
        .shadowRoot.querySelector('[data-id="global/about-the-user/meetings"] .actions')
  );
  await page.evaluate(() =>
    [
      ...window
        .memoryView()
        .shadowRoot.querySelectorAll(
          '[data-id="global/about-the-user/meetings"] .actions swc-action-button'
        ),
    ]
      .find((button) => button.textContent.includes('Forget'))
      .click()
  );
  await page.until(
    () => !!window.deep(document, 'slicc-confirm')?.shadowRoot?.querySelector('dialog[open]')
  );
  await page.evaluate(() =>
    [...window.deep(document, 'slicc-confirm').shadowRoot.querySelectorAll('swc-button')]
      .find((button) => button.textContent.trim() === 'Forget')
      .click()
  );
  await page.until(
    async (path) => !(await window.readFile(path)).includes('### Meetings'),
    GLOBAL_MEMORY
  );
  assert.equal(
    await page.evaluate((path) => window.readFile(path), GLOBAL_MEMORY),
    '## About the user\n\n### Name\ntag: user\n\nThe user is Sam, at Example Inc.\n\n## Preferences\n\n### Short replies\ntag: feedback\n\nSam likes short replies with the answer first.\n'
  );
  await page.until(
    () => !window.deepText(window.memoryView().shadowRoot).includes('Sam prefers meetings')
  );

  assert.equal(
    await page.evaluate(() =>
      document.querySelector('slicc-app').dock.api.panels.some((panel) => panel.id === 'changes')
    ),
    false
  );
  const openChanges = async () => {
    await page.until(
      () =>
        !!window.deep(document.querySelector('slicc-app').shadowRoot, '[data-surface="changes"]')
    );
    await page.evaluate(() =>
      window
        .deep(document.querySelector('slicc-app').shadowRoot, '[data-surface="changes"]')
        .click()
    );
    await page.until(
      () =>
        !!document
          .querySelector('slicc-app')
          .dock.content('changes')
          ?.shadowRoot?.querySelector('[data-unavailable]')
    );
  };
  await openChanges();
  assert.match(
    await page.evaluate(
      () =>
        document
          .querySelector('slicc-app')
          .dock.content('changes')
          .shadowRoot.querySelector('[data-unavailable]').textContent
    ),
    /git/i
  );
  await page.screenshot(new URL('changes-light.png', page.dir));
  await color('dark');
  await page.screenshot(new URL('changes-dark.png', page.dir));
  await color('light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('changes'));
  await page.until(
    () =>
      !!document
        .querySelector('slicc-app')
        .dock.content('changes')
        ?.shadowRoot?.querySelector('[data-unavailable]')
  );
  await page.screenshot(new URL('changes-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');

  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    window.freezerView = () => app.dock.content('freezer');
    window.rows = () => app.model.agent.frozen();
    window.cardButton = (id, action) =>
      window
        .freezerView()
        ?.shadowRoot?.querySelector(`.card[data-id="${id}"] [data-action="${action}"]`);
    window.deleteCone = (id) =>
      window.deep(document, `[data-action="delete-cone"][id="delete-${id}"]`);
    window.confirmDialog = () =>
      window.deep(document, 'slicc-confirm')?.shadowRoot?.querySelector('dialog[open]');
    window.confirmButton = (label) =>
      [...window.deep(document, 'slicc-confirm').shadowRoot.querySelectorAll('swc-button')].find(
        (button) => button.textContent.trim() === label
      );
    app.show('freezer');
  });
  const live = await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    return app.model.agent.list().find((agent) => agent.id === app.model.agent.active());
  });
  await page.until(
    (id) =>
      !!window.freezerView()?.shadowRoot?.querySelector(`.card[data-id="${id}"][data-live]`) &&
      !!window.cardButton(id, 'open'),
    live.id
  );
  const freezerShots = async (name) => {
    await page.screenshot(new URL(`freezer-${name}-light.png`, page.dir));
    await color('dark');
    await page.screenshot(new URL(`freezer-${name}-dark.png`, page.dir));
    await color('light');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.until(() => document.querySelector('slicc-app').screen === 'phone');
    await page.evaluate(() => document.querySelector('slicc-app').show('freezer'));
    await page.until(() => !!window.freezerView()?.shadowRoot?.querySelector('.list'));
    await page.screenshot(new URL(`freezer-${name}-420.png`, page.dir));
    await page.send('Emulation.clearDeviceMetricsOverride');
    await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
    await page.evaluate(() => document.querySelector('slicc-app').show('freezer'));
  };
  await freezerShots('live');

  const removeCone = async ({ id, name }) => {
    await page.evaluate(() => document.querySelector('slicc-app').show('agents'));
    await page.until((id) => !!window.deleteCone(id), id);
    await page.evaluate((id) => window.deleteCone(id).click(), id);
    await page.until(() => !!window.confirmDialog());
    assert.match(
      await page.evaluate(() => window.deep(document, 'slicc-confirm').heading),
      new RegExp(`^Delete cone ${name}( \\(.+\\))?\\?$`)
    );
    await page.evaluate(() => window.confirmButton('Delete cone').click());
    await page.until(() => !window.confirmDialog());
    await page.evaluate(() => document.querySelector('slicc-app').show('freezer'));
  };
  await page.evaluate(() => {
    window.rowsBefore = window.rows().map((row) => row.id);
  });
  await removeCone(live);
  await page.until(() =>
    window.rows().some((row) => !row.live && row.title && !window.rowsBefore.includes(row.id))
  );
  const frozen = await page.evaluate(() =>
    window.rows().find((row) => !row.live && !window.rowsBefore.includes(row.id))
  );
  assert.equal(frozen.name, live.name);
  assert.ok(frozen.messages >= 2);
  await page.until(
    ([id, title]) =>
      window.freezerView().shadowRoot.querySelector(`.card[data-id="${id}"] .title`)
        ?.textContent === title && !!window.cardButton(id, 'thaw'),
    [frozen.id, frozen.title]
  );
  await freezerShots('frozen');

  await page.evaluate(() => {
    window.before = document
      .querySelector('slicc-app')
      .model.agent.list()
      .map((agent) => agent.id);
  });
  await page.evaluate((id) => window.cardButton(id, 'thaw').click(), frozen.id);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.agent.list()
      .some((agent) => agent.kind === 'cone' && !window.before.includes(agent.id))
  );
  const thawed = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.agent.list()
      .find((agent) => agent.kind === 'cone' && !window.before.includes(agent.id))
  );
  assert.match(thawed.name, new RegExp(`^${live.name}`));
  const twins = async (name) => {
    await page.evaluate(() => {
      const app = document.querySelector('slicc-app');
      app.show('agents');
      const picker = app.shadowRoot.querySelector('header sp-picker');
      if (picker) picker.open = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.screenshot(new URL(`twins-${name}.png`, page.dir));
    await page.evaluate(() => {
      const picker = document
        .querySelector('slicc-app')
        .shadowRoot.querySelector('header sp-picker');
      if (picker) picker.open = false;
    });
  };
  await twins('1280-light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await twins('420-light');
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await page.evaluate(() => document.querySelector('slicc-app').show('freezer'));

  await page.evaluate(() => {
    window.rowsBefore = window.rows().map((row) => row.id);
  });
  await removeCone(thawed);
  await page.until(
    (id) =>
      !document
        .querySelector('slicc-app')
        .model.agent.list()
        .some((agent) => agent.id === id),
    thawed.id
  );
  await page.until(() =>
    window.rows().some((row) => !row.live && !window.rowsBefore.includes(row.id))
  );
  const gone = await page.evaluate(() =>
    window.rows().find((row) => !row.live && !window.rowsBefore.includes(row.id))
  );
  assert.equal(gone.name, thawed.name);
  await page.until((id) => !!window.cardButton(id, 'remove'), gone.id);
  await page.evaluate((id) => window.cardButton(id, 'remove').click(), gone.id);
  await page.until(() => !!window.confirmDialog());
  assert.match(
    await page.evaluate(() => window.deep(document, 'slicc-confirm').heading),
    new RegExp(`^Remove ${thawed.name}( \\(.+\\))? from the Freezer\\?$`)
  );
  await page.screenshot(new URL('freezer-remove-light.png', page.dir));
  await color('dark');
  await page.screenshot(new URL('freezer-remove-dark.png', page.dir));
  await color('light');
  await page.evaluate(() => window.confirmButton('Cancel').click());
  await page.until(() => !window.confirmDialog());
  assert.ok(await page.evaluate((id) => window.rows().some((row) => row.id === id), gone.id));
  await page.evaluate((id) => window.cardButton(id, 'remove').click(), gone.id);
  await page.until(() => !!window.confirmDialog());
  await page.evaluate(() => window.confirmButton('Remove').click());
  await page.until((id) => !window.rows().some((row) => row.id === id), gone.id);

  await page.evaluate(() => {
    localStorage.setItem('test.storage', JSON.stringify({ persisted: false, persist: true }));
  });
  await page.reload();
  await ready(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .dock.api.panels.some((panel) => panel.id.startsWith('chat:'))
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  const reloaded = await page.evaluate(() => window.persistCalls);
  await sendChat('Say hello once more');
  await page.until((before) => window.persistCalls === before + 1, reloaded);
  assert.equal(await page.evaluate(() => !!window.storageNotice()), false);
  assert.deepEqual(
    await page.evaluate(() => document.querySelector('slicc-app').model.notices.list()),
    []
  );
  assert.deepEqual(page.errors, []);
});
