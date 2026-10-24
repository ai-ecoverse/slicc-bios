import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentState, agentUp, connectAccount, listsAccount, ready, run, shows } from './bios.mjs';
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

const usage = eventFrame('metadata', {
  usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
  metrics: { latencyMs: 1 },
});
const said = (text) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text } }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'end_turn' }),
    usage,
  ]);
const bashCall = (toolUseId, command) =>
  Buffer.concat([
    eventFrame('messageStart', { role: 'assistant' }),
    eventFrame('contentBlockStart', {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId, name: 'bash' } },
    }),
    eventFrame('contentBlockDelta', {
      contentBlockIndex: 0,
      delta: { toolUse: { input: JSON.stringify({ command }) } },
    }),
    eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
    eventFrame('messageStop', { stopReason: 'tool_use' }),
    usage,
  ]);
const toolResults = [];
function scripted(raw) {
  let sent;
  try {
    sent = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (!sent.toolConfig?.tools?.some((tool) => tool.toolSpec?.name === 'bash')) return null;
  const last = sent.messages?.at(-1);
  if (last?.role !== 'user') return null;
  const result = last.content.find((part) => part.toolResult)?.toolResult;
  if (result) {
    toolResults.push({
      id: result.toolUseId,
      status: result.status,
      text: result.content.map((part) => part.text ?? '').join(''),
    });
    return said('Ran it.');
  }
  const command = last.content
    .map((part) => part.text ?? '')
    .join('')
    .match(/RUN: ([^\n]+)/)?.[1];
  return command ? bashCall(`run-${toolResults.length + 1}`, command) : null;
}

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
    const target = `${back}?nonce=${state.nonce}#access_token=${ADOBE_TOKEN}&token_type=bearer&expires_in=86399`;
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
  answer: async (request, raw) => {
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
    if (request.url.startsWith('https://tools.example.test/')) {
      return {
        status: 200,
        headers: [
          ['content-type', 'text/plain'],
          ['x-upstream', 'tools'],
        ],
        body: Buffer.from('upstream\n'),
      };
    }
    if (request.url.startsWith('https://tracker.example.com/')) {
      return {
        status: 401,
        headers: [
          ['content-type', 'application/json'],
          ['www-authenticate', 'Bearer'],
        ],
        body: Buffer.from('{"error":"invalid_token"}'),
      };
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
      body: scripted(raw) ?? stream,
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

const signInWindows = () => {
  globalThis.sliccLoginDebug = true;
  window.signInWindows = [];
  const open = window.open;
  window.open = function (...args) {
    if (args[1] === 'slicc-sign-in') window.signInWindows.push(String(args[0]));
    return open.apply(this, args);
  };
};

const SHOWN = 5 * 60 * 1000;

async function eventually(check, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`still false after ${ms} ms: ${check}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const UPDATE = 5 * 60 * 1000;
const GLOBAL_MEMORY = '/root/.pi/agent/memory/MEMORY.md';
const CONE_MEMORY = '/root/.pi/agent/memory/cone/MEMORY.md';

test('chat in seven answers through the agent worker, Bedrock and the local proxy', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(storageStub);
  await page.init(signInWindows);
  await page.init(() => {
    globalThis.sliccKernelDebug = true;
  });
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page, undefined, { tools: false });
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
  await page
    .within(SHOWN, () => {
      const { state, progress } = window.agentRow();
      return (
        state === 'downloading' &&
        progress.done > 0 &&
        progress.total >= 10 &&
        window.updatesOpen() &&
        !document.querySelector('slicc-app').model.updates.ready()
      );
    })
    .catch(async (error) => {
      throw new Error(
        `the panel never showed the download: ${error.message}\n${await agentState(page)}`
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
  await agentUp(page);
  await listsAccount(page, 'amazon-bedrock');
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
  assert.equal(
    account.needs ?? null,
    null,
    'Bedrock’s listing no longer asks for a CORS-free transport'
  );

  const connect = (key) => connectAccount(page, 'amazon-bedrock', key);
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
        ) &&
        !request.body.includes('Give this chat a title')
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
  await page.evaluate(async () => {
    const client = await globalThis.sliccKernelClient();
    window.kernelSaw = [];
    await client.fs.watch(['/var/lib/slicc/agent'], { recursive: true }, ({ paths = [] }) =>
      window.kernelSaw.push(...paths)
    );
  });
  chrome.overrides.set('/packages/agent/pnpm-lock.yaml', `${lock}# updated\n`);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.within(UPDATE, () => window.agentRow().state === 'ready');
  await page
    .within(5000, () =>
      ['applied.json', 'pnpm-lock.yaml'].every((name) =>
        window.kernelSaw.some((path) => path.endsWith(`/var/lib/slicc/agent/${name}`))
      )
    )
    .catch(async (error) => {
      throw new Error(
        `the running kernel never saw seven's own writes under /var/lib/slicc/agent: ${error.message}\nsaw ${JSON.stringify(await page.evaluate(() => window.kernelSaw))}`
      );
    });
  assert.deepEqual(await page.evaluate(() => [window.agentRow().actions, window.updatesOpen()]), [
    ['restart-agent'],
    false,
  ]);
  const shipped = await page.evaluate(async (dist) => {
    const manifest = JSON.parse(await window.readFile(`${dist}/package.json`));
    const owner = await window.readFile(`${dist}/dist/owner.js`);
    const port = await window.readFile(`${dist}/dist/spectrum/agent-port.js`);
    if (!/\bclass AgentAdapter\b/.test(port)) throw new Error('agent-port.js has no AgentAdapter');
    await window.writeFile(
      `${dist}/dist/owner.js`,
      `${owner}\nglobalThis.sevenAdapters = [...(globalThis.sevenAdapters ?? []), 'next'];\n`
    );
    await window.writeFile(
      `${dist}/dist/spectrum/agent-port.js`,
      `${port}\nAgentAdapter.prototype.sevenBuild = 'next';\n`
    );
    const next = `${manifest.version}-next`;
    await window.writeFile(`${dist}/package.json`, JSON.stringify({ ...manifest, version: next }));
    return manifest.version;
  }, '/opt/agent/node_modules/@ai-ecoverse/slicc-agent');
  assert.equal(
    await page.evaluate(() => document.querySelector('slicc-app').model.agent.sevenBuild),
    undefined
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
  await page.until(() => !!window.updatesButton('agent', 'restart-agent'));
  await page.screenshot(new URL('restart.png', page.dir));
  await page.evaluate(() => window.updatesButton('agent', 'restart-agent').click());
  await page.until(() => window.agentRow().state === 'current');
  assert.deepEqual(
    await page.evaluate(() => [
      window.agentRow().to,
      globalThis.sevenAdapters,
      document.querySelector('slicc-app').model.agent.sevenBuild,
    ]),
    [`${shipped}-next`, ['next'], 'next']
  );
  await eventually(() => keyed().length === 2, UPDATE);
  assert.match(keyed()[1].body, /channel=\\?"upgrade\\?"/);
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  await page.until(() => {
    const { agent } = document.querySelector('slicc-app').model;
    return (
      !agent.busy(agent.active()) &&
      window.deepText(window.chatView().shadowRoot).split('Hello from Bedrock in seven.').length ===
        3
    );
  });
  await sendChat('Say hello again');
  assert.equal(await page.evaluate(() => window.persistCalls), booted + 3);
  await page.until(
    () =>
      window.deepText(window.chatView().shadowRoot).split('Hello from Bedrock in seven.').length ===
      4
  );
  assert.equal(keyed().length, 3);

  const other = await page.tab();
  await other.init(helpers);
  await other.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(other);
  await other.until(
    () => document.querySelector('slicc-app').model.tabs?.state().role === 'follower'
  );
  await other.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await other.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  await other.until(
    () =>
      window.deepText(window.chatView().shadowRoot).split('Hello from Bedrock in seven.').length ===
      4
  );
  await other.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
  await other.insert('Say hello from the other tab');
  await other.enter();
  const answered = () =>
    window.deepText(window.chatView().shadowRoot).split('Hello from Bedrock in seven.').length ===
    5;
  await other.until(answered);
  await page.until(answered);
  assert.equal(keyed().length, 4);
  assert.match(keyed()[3].body, /Say hello from the other tab/);
  assert.deepEqual(other.errors, []);
  await other.close();

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
  const quiet = {
    windows: await page.evaluate(() => window.signInWindows.length),
    registered: proxy.registered.length,
    authorized: authorized.length,
  };
  assert.equal(
    await page.evaluate(() =>
      globalThis
        .sliccLogin('adobe', async () => ({ clientId: 'test-client', scopes: 'openid,AdobeID' }), {
          signal: AbortSignal.abort(),
        })
        .then(
          () => 'resolved',
          (error) => error.name
        )
    ),
    'AbortError'
  );
  assert.deepEqual(
    {
      windows: await page.evaluate(() => window.signInWindows.length),
      registered: proxy.registered.length,
      authorized: authorized.length,
    },
    quiet
  );
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
  assert.deepEqual(
    await page.evaluate(() => {
      const { kind, role, connection, budget } = document
        .querySelector('slicc-app')
        .model.tray.status();
      return { kind, role, connection, percent: budget.percent };
    }),
    { kind: 'hosted', role: 'none', connection: 'offline', percent: 42 }
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.settings.models()
      .some((option) => option.id === 'adobe/claude-test')
  );
  await page.screenshot(new URL('adobe.png', page.dir));
  const ims = chrome.vault.state.records.find((record) => record.name === 'ADOBE_IMS_TOKEN');
  assert.deepEqual(
    { kind: ims.kind, provider: ims.provider, source: ims.source },
    { kind: 'model', provider: 'adobe', source: 'oauth:adobe' }
  );
  assert.ok(
    Math.abs(ims.expiresAt - Date.now() - 86399000) < 10 * 60 * 1000,
    String(ims.expiresAt)
  );

  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    window.monitorView = () => app.dock.content('monitor');
    window.monitorSection = (id) =>
      window.monitorView()?.shadowRoot?.querySelector(`.section[data-id="${id}"]`);
    window.monitorRows = (id) => [...(window.monitorSection(id)?.querySelectorAll('.row') ?? [])];
    window.monitorOpen = () => app.dock.api.panels.some((panel) => panel.id === 'monitor');
    window.usageButton = () =>
      window.deep(app.shadowRoot, 'slicc-tray')?.shadowRoot?.querySelector('#usage');
  });
  assert.equal(await page.evaluate(() => window.monitorOpen()), false);
  await page.until(() => window.usageButton()?.localName === 'swc-action-button');
  await page.evaluate(() => window.usageButton().click());
  await page.until(() => window.monitorOpen() && !!window.monitorView()?.shadowRoot);
  const expand = async () => {
    await page.until(() =>
      ['processes'].every(
        (id) => Number(window.monitorSection(id)?.querySelector('.num')?.textContent) > 0
      )
    );
    await page.evaluate(() => {
      window.monitorClicked = 0;
    });
    await page.until(() => {
      if (window.monitorRows('processes').length > 0) return true;
      if (Date.now() - window.monitorClicked < 1000) return false;
      window.monitorClicked = Date.now();
      for (const id of ['tasks', 'processes']) {
        const toggle = window.monitorSection(id)?.querySelector('button.toggle');
        if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
      }
      return false;
    });
  };
  await expand();
  const watched = await page.evaluate(() => {
    const { monitor, agent } = document.querySelector('slicc-app').model;
    const snapshot = monitor.snapshot();
    const section = (id) => snapshot.sections.find((item) => item.id === id);
    const cones = agent.list().length;
    return {
      updated: snapshot.updatedAt > 0,
      vitals: snapshot.vitals.map((vital) => vital.id),
      cone: snapshot.vitals.find((vital) => vital.id === 'agents')?.unit === `of ${cones}`,
      shell: section('processes').rows.some((row) => /\bbash\b/.test(row.name)),
      shown: window.monitorRows('processes').map((row) => row.dataset.id),
      bar: window.deepText(window.monitorView().shadowRoot.querySelector('.bar')),
    };
  });
  assert.equal(watched.updated, true);
  assert.ok(watched.vitals.includes('agents') && watched.vitals.includes('processes'));
  assert.equal(watched.cone, true);
  assert.equal(watched.shell, true);
  assert.ok(watched.shown.length > 0);
  assert.match(watched.bar, /Live monitor[\s\S]*Updated \d\d:\d\d:\d\d UTC/);
  await page.screenshot(new URL('monitor-light-1280.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .shadowRoot.querySelector('.swc-theme')
      .classList.contains('swc-theme--dark')
  );
  await page.screenshot(new URL('monitor-dark-1280.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('monitor'));
  await page.until(() => window.monitorOpen() && !!window.monitorView()?.shadowRoot);
  await expand();
  await page.screenshot(new URL('monitor-light-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  await page.evaluate(() => document.querySelector('slicc-app').dock.close('monitor'));
  await page.until(() => !window.monitorOpen());
  await new Promise((resolve) => setTimeout(resolve, 11000));
  assert.deepEqual(page.errors, []);
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
  await page.evaluate(() => {
    const head = window
      .memoryView()
      .shadowRoot.querySelector('[data-id="global/about-the-user/meetings"] .head');
    if (head.getAttribute('aria-expanded') !== 'true') head.click();
  });
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

  const servers = {
    mcpServers: {
      docs: {
        url: 'https://docs.example.com/mcp',
        headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
        description: 'Search the product docs',
      },
      tracker: { url: 'https://tracker.example.com/mcp', description: 'Release issues' },
    },
  };
  await run(
    page,
    `mkdir -p /etc/slicc/agent && echo ${Buffer.from(JSON.stringify(servers)).toString('base64')} | base64 -d > /etc/slicc/agent/mcp.json; echo "mcp $((6 * 7))"`
  );
  await shows(page, 'mcp 42');
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.settings.accounts()
        .filter((item) => item.group === 'mcp').length === 2
  );
  const [docs, tracker] = await page.evaluate(() =>
    ['mcp:docs', 'mcp:tracker'].map((id) =>
      document
        .querySelector('slicc-app')
        .model.settings.accounts()
        .find((item) => item.id === id)
    )
  );
  assert.deepEqual([docs.auth, docs.secret, docs.status], ['api-key', 'token', 'disconnected']);
  assert.deepEqual([tracker.auth, tracker.status], ['oauth', 'disconnected']);
  const callback = await page.evaluate(async () => {
    const response = await fetch(new URL('../oauth/mcp-callback?code=x&state=y', location.href));
    let dir = await navigator.storage.getDirectory();
    for (const part of 'opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/oauth'.split('/'))
      dir = await dir.getDirectoryHandle(part);
    const page = await (await dir.getFileHandle('mcp-callback.html')).getFile();
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      same: (await response.text()) === (await page.text()),
      channel: (await page.text()).includes('slicc-mcp-oauth'),
    };
  });
  assert.deepEqual(callback, {
    status: 200,
    type: 'text/html; charset=utf-8',
    same: true,
    channel: true,
  });
  const mcpRow = async () => {
    await page.evaluate(() => document.querySelector('slicc-app').show('settings'));
    await page.until(
      () =>
        !!window.deep(
          document.querySelector('slicc-app').dock.content('settings').shadowRoot,
          '.accounts[data-group=mcp] [data-id="mcp:tracker"]'
        )
    );
    await page.evaluate(() =>
      window
        .deep(
          document.querySelector('slicc-app').dock.content('settings').shadowRoot,
          '.accounts[data-group=mcp]'
        )
        .scrollIntoView({ block: 'center' })
    );
  };
  await mcpRow();
  await page.screenshot(new URL('settings-mcp-light-1280.png', page.dir));
  await color('dark');
  await page.screenshot(new URL('settings-mcp-dark-1280.png', page.dir));
  await color('light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await mcpRow();
  await page.screenshot(new URL('settings-mcp-light-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');

  const origins = await page.evaluate(async () => {
    const at = new URL(
      '../opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/browser/origins.js',
      location.href
    );
    const source = await (await fetch(at)).text();
    const [, url] =
      source.match(/from\s*"([^"]*catalog\.json)"\s*with\s*\{\s*type:\s*['"]json['"]\s*\}/) ?? [];
    if (!url) return { url: null };
    const response = await fetch(new URL(url, at));
    const catalog = await response.json();
    return {
      url: new URL(url, at).pathname,
      status: response.status,
      type: response.headers.get('content-type'),
      from: response.headers.get('x-served-from'),
      parsed: typeof catalog === 'object' && catalog !== null,
    };
  });
  assert.match(
    origins.url,
    /^\/opt\/agent\/node_modules\/.*@ai-ecoverse\/slicc-browsers\/catalog\.json$/
  );
  assert.deepEqual(
    [origins.status, origins.type, origins.from, origins.parsed],
    [200, 'application/json', 'opfs', true]
  );

  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    window.panelIds = () => app.dock.api.panels.map((panel) => panel.id);
    window.panelLeft = (id) =>
      app.dock.api.getPanel(id)?.group.element.getBoundingClientRect().left ?? null;
    window.panelSide = (id) => {
      const at = window.panelLeft(id);
      const chat = window.panelLeft(window.panelIds().find((panel) => panel.startsWith('chat:')));
      return at === null || chat === null
        ? null
        : at < chat
          ? 'left'
          : at > chat
            ? 'right'
            : 'center';
    };
  });
  const agentRun = async (command) => {
    const before = toolResults.length;
    await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
    await page.until(
      () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
    );
    await sendChat(`RUN: ${command}`);
    await eventually(() => toolResults.length > before, 120000);
    await page.until(() => {
      const { agent } = document.querySelector('slicc-app').model;
      return !agent.busy(agent.active());
    });
    return toolResults[before];
  };
  const lightIn = async (viewed) => {
    await viewed.evaluate(() => {
      const app = document.querySelector('slicc-app');
      if (app.color !== 'light') app.toggleColor();
    });
    await viewed.until(() =>
      document
        .querySelector('slicc-app')
        .shadowRoot.querySelector('.swc-theme')
        .classList.contains('swc-theme--light')
    );
  };
  const openLastTool = async () => {
    await page.evaluate(async () => {
      const found = [];
      const walk = (root) => {
        found.push(...root.querySelectorAll('swc-response-status-step[data-target]'));
        for (const element of root.querySelectorAll('*'))
          if (element.shadowRoot) walk(element.shadowRoot);
      };
      walk(window.chatView().shadowRoot);
      window.deep(window.chatView().shadowRoot, 'textarea').blur();
      const last = found.filter((step) => step.querySelector('.run-toggle')).at(-1);
      const status = last.closest('swc-response-status');
      if (status && !status.open) status.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!last.hasAttribute('data-open')) last.querySelector('.run-toggle').click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const detail = last.getRootNode().querySelector(`[id="detail-${last.dataset.target}"]`);
      (detail ?? last).scrollIntoView({ block: 'center' });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  const settled = (viewed) =>
    viewed.until(() => {
      const app = document.querySelector('slicc-app');
      if (app.model.notices.list().some((notice) => notice.id === 'storage'))
        app.model.notices.dismiss('storage');
      if (!app.dock.api.panels.some((panel) => panel.id === 'monitor')) return true;
      const processes = app.model.monitor
        .snapshot()
        .vitals.find((vital) => vital.id === 'processes');
      return /^\d+$/.test(processes?.value ?? '');
    });
  const panelShots = async (name, viewed, phone) => {
    await lightIn(viewed);
    await settled(viewed);
    await viewed.screenshot(new URL(`panel-${name}-light-1280.png`, page.dir));
    await viewed.evaluate(() => {
      const app = document.querySelector('slicc-app');
      if (app.color !== 'dark') app.toggleColor();
    });
    await viewed.until(() =>
      document
        .querySelector('slicc-app')
        .shadowRoot.querySelector('.swc-theme')
        .classList.contains('swc-theme--dark')
    );
    await settled(viewed);
    await viewed.screenshot(new URL(`panel-${name}-dark-1280.png`, page.dir));
    await viewed.evaluate(() => document.querySelector('slicc-app').toggleColor());
    await viewed.send('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await viewed.until(() => document.querySelector('slicc-app').screen === 'phone');
    await phone();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await settled(viewed);
    await viewed.screenshot(new URL(`panel-${name}-light-420.png`, page.dir));
    await viewed.send('Emulation.clearDeviceMetricsOverride');
    await viewed.until(() => document.querySelector('slicc-app').screen === 'desktop');
  };

  const guarded = await agentRun('playwright-cli open https://seven.sliccy.ai/');
  assert.match(
    guarded.text,
    /SLICC's own pages can't be opened or driven from the browser tools\./
  );

  const confirmOf = () => {
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.localName === 'slicc-confirm') return element;
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(document);
  };
  const asking = agentRun(
    `printf '{"kind":"open.url","url":"%s"}\\n' https://example.test/agent | cat > /dev/embedder; echo "agent open $?"`
  );
  await page.until(
    (find) => !!new Function(`return (${find})()`)()?.shadowRoot?.querySelector('[data-cancel]'),
    confirmOf.toString()
  );
  assert.match(
    await page.evaluate(
      (find) => new Function(`return (${find})()`)().shadowRoot.textContent,
      confirmOf.toString()
    ),
    /The agent \S+ asks seven to open https:\/\/example\.test\/agent/
  );
  await page.evaluate(
    (find) =>
      new Function(`return (${find})()`)().shadowRoot.querySelector('[data-cancel]').click(),
    confirmOf.toString()
  );
  const cancelledOpen = Date.now();
  const refusedOpen = await asking;
  assert.match(refusedOpen.text, /the request to open the page was dismissed/);
  assert.match(refusedOpen.text, /agent open 1/);
  const { targetInfos: agentTabs } = await chrome.cdp.send('Target.getTargets');
  assert.deepEqual(
    agentTabs.filter(({ url }) => url.startsWith('https://example.test/agent')),
    []
  );

  await page.evaluate(() => {
    window.micOpened = 0;
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: async () => {
        window.micOpened += 1;
        throw new DOMException('denied by the test', 'NotAllowedError');
      },
    });
  });
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, cancelledOpen + 10_500 - Date.now()))
  );
  const recording = agentRun(
    `printf '%s\\n' '{"kind":"audio.record","seconds":1}' | cat > /dev/embedder; echo "agent rec $?"`
  );
  await page.until(
    (find) => !!new Function(`return (${find})()`)()?.shadowRoot?.querySelector('[data-cancel]'),
    confirmOf.toString()
  );
  assert.match(
    await page.evaluate(
      (find) => new Function(`return (${find})()`)().shadowRoot.textContent,
      confirmOf.toString()
    ),
    /Use the microphone\?.*The agent \S+ asks seven to record from your microphone for up to 1 second\./s
  );
  await page.evaluate(
    (find) =>
      new Function(`return (${find})()`)().shadowRoot.querySelector('[data-cancel]').click(),
    confirmOf.toString()
  );
  const refusedMic = await recording;
  assert.match(refusedMic.text, /the request to use the microphone was dismissed/);
  assert.match(refusedMic.text, /agent rec 1/);
  assert.equal(await page.evaluate(() => window.micOpened), 0);

  await run(page, 'echo "tab=$SLICC_TAB"');
  await page.until(() =>
    /tab=[0-9a-f-]{36}/.test(
      document
        .querySelector('slicc-app')
        .dock.content(window.panelIds().findLast((id) => id.startsWith('terminal:'))).screen
        .textContent
    )
  );
  const ownTab = await page.evaluate(
    () =>
      document
        .querySelector('slicc-app')
        .dock.content(window.panelIds().findLast((id) => id.startsWith('terminal:')))
        .screen.textContent.match(/tab=([0-9a-f-]{36})/)[1]
  );

  assert.equal(await page.evaluate(() => window.panelIds().includes('monitor')), false);
  const opened = await agentRun('panel open monitor left');
  assert.equal(opened.status, 'success', opened.text);
  await page.until(
    () => window.panelIds().includes('monitor') && window.panelSide('monitor') === 'left'
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(() => window.panelSide('monitor') === 'left');
  await panelShots('open-monitor-left', page, async () => {
    const shown = await agentRun('panel open monitor');
    assert.equal(shown.status, 'success', shown.text);
    await page.until(() => window.panelIds().includes('monitor'));
    await page.evaluate(() => document.querySelector('slicc-app').show('monitor'));
  });
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));

  const reset = await agentRun('panel reset');
  assert.equal(reset.status, 'success', reset.text);
  await page.until(() => !window.panelIds().includes('monitor'));
  assert.deepEqual(
    await page.evaluate(() => ['agents', 'files'].map((id) => window.panelSide(id))),
    ['left', 'left']
  );
  await panelShots('reset', page, async () => {
    const phoneReset = await agentRun('panel reset');
    assert.equal(phoneReset.status, 'success', phoneReset.text);
    await page.until(() => !window.panelIds().includes('monitor'));
  });
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));

  const second = await page.tab();
  await second.init(helpers);
  await second.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(second);
  await second.until(
    () => document.querySelector('slicc-app').model.tabs?.state().role === 'follower'
  );
  await second.until(() => !!document.querySelector('slicc-app').model.agent);
  await page.send('Page.bringToFront');

  let listed;
  for (let tries = 0; tries < 20; tries += 1) {
    listed = await agentRun('panel tabs --json');
    if (JSON.parse(listed.text.match(/\[[\s\S]*\]/)?.[0] ?? '[]').length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const tabs = JSON.parse(listed.text.match(/\[[\s\S]*\]/)[0]);
  assert.equal(tabs.length, 2, listed.text);
  assert.ok(tabs.some((tab) => tab.tab === ownTab));
  const otherTab = tabs.find((tab) => tab.tab !== ownTab).tab;
  const table = await agentRun('panel tabs');
  assert.ok(table.text.includes(ownTab) && table.text.includes(otherTab), table.text);
  await lightIn(page);
  await settled(page);
  await openLastTool();
  await page.screenshot(new URL('panel-tabs-light-1280.png', page.dir));

  const routed = await agentRun(`panel --tab ${otherTab} open monitor right`);
  assert.equal(routed.status, 'success', routed.text);
  await second.evaluate(() => {
    const app = document.querySelector('slicc-app');
    window.panelIds = () => app.dock.api.panels.map((panel) => panel.id);
  });
  await second.until(() => window.panelIds().includes('monitor'));
  assert.equal(await page.evaluate(() => window.panelIds().includes('monitor')), false);
  await second.send('Page.bringToFront');
  await second.until(() => {
    const { dock } = document.querySelector('slicc-app');
    const at = dock.api.getPanel('monitor').group.element.getBoundingClientRect().left;
    const chat = dock.api.panels.find((panel) => panel.id.startsWith('chat:'));
    return !chat || at > dock.api.getPanel(chat.id).group.element.getBoundingClientRect().left;
  });
  await panelShots('tab-other-monitor-right', second, () =>
    second.evaluate(() => document.querySelector('slicc-app').show('monitor'))
  );
  assert.deepEqual(second.errors, []);
  await second.close();
  await page.send('Page.bringToFront');

  await page.evaluate(() => document.querySelector('slicc-app').dock.close('files'));
  await page.until(() => !window.panelIds().includes('files'));
  const refused = await agentRun('panel open files');
  assert.match(
    refused.text,
    /the user closed files (\d+ s ago|just now); ask before opening it again/
  );
  assert.match(refused.text, /exited with code 5/);
  assert.equal(await page.evaluate(() => window.panelIds().includes('files')), false);
  await lightIn(page);
  await settled(page);
  await openLastTool();
  await page.screenshot(new URL('panel-refused-light-1280.png', page.dir));
  assert.deepEqual(page.errors, []);
});

const persisted = () => {
  try {
    localStorage.setItem('test.storage', '{"persisted":true,"persist":true}');
  } catch {}
};

test('an agent that failed to start at boot loads the new page adapter once an update installs one, and Retry recovers it without a reload', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(persisted);
  await page.init(storageStub);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await agentUp(page);
  await connectAccount(page, 'amazon-bedrock', KEY);
  const dist = '/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist';
  const original = await page.evaluate((dist) => window.readFile(`${dist}/page.js`), dist);
  const owner = /\bstartAgent\n\} from "\.\/owner\.js";/;
  assert.match(original, owner);
  const broken = original.replace(
    owner,
    'startAgent as ownerStart\n} from "./owner.js";\nglobalThis.sevenAdapters = [...(globalThis.sevenAdapters ?? []), "old"];\nconst startAgent = () => Promise.reject(new Error("this build does not start"));'
  );
  await page.evaluate((dist, text) => window.writeFile(`${dist}/page.js`, text), dist, broken);
  await page.reload();
  await ready(page);
  const row = () =>
    page.evaluate(() => {
      const item = document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((entry) => entry.id === 'agent');
      return { state: item.state, error: item.error ?? null, adapters: globalThis.sevenAdapters };
    });
  await page
    .within(UPDATE, () => {
      const list = document.querySelector('slicc-app').model.updates.list();
      const item = list.find((entry) => entry.id === 'agent');
      return (
        !!item.checkedAt &&
        item.state === 'failed' &&
        /Couldn't start the agent/.test(item.error ?? '') &&
        globalThis.sevenAdapters?.[0] === 'old'
      );
    })
    .catch(async (error) => {
      throw new Error(`${error.message}\n${JSON.stringify(await row())}`);
    });
  assert.match((await row()).error, /Couldn't start the agent/);

  const fresh = original.replace(
    owner,
    'startAgent as ownerStart\n} from "./owner.js";\nglobalThis.sevenAdapters = [...(globalThis.sevenAdapters ?? []), "new"];\nlet sevenTries = 0;\nconst startAgent = (...args) => (sevenTries++ === 0 ? Promise.reject(new Error("the first start fails")) : ownerStart(...args));'
  );
  await page.evaluate((dist, text) => window.writeFile(`${dist}/page.js`, text), dist, fresh);
  const lock = await readFile(
    new URL('../../src/packages/agent/pnpm-lock.yaml', import.meta.url),
    'utf8'
  );
  chrome.overrides.set('/packages/agent/pnpm-lock.yaml', `${lock}# updated\n`);
  t.after(() => chrome.overrides.delete('/packages/agent/pnpm-lock.yaml'));
  await page.evaluate(() => {
    const { updates } = document.querySelector('slicc-app').model;
    window.agentStates = [];
    updates.on('items', () =>
      window.agentStates.push(updates.list().find((entry) => entry.id === 'agent').state)
    );
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const settled = () => {
    const { updates } = document.querySelector('slicc-app').model;
    const { state } = updates.list().find((entry) => entry.id === 'agent');
    return updates.ready() || (window.agentStates.includes('installed') && state === 'failed');
  };
  await page.within(UPDATE, settled).catch(async (error) => {
    throw new Error(`${error.message}\n${JSON.stringify(await row())}`);
  });
  const installed = await row();
  assert.deepEqual(installed.adapters, ['old', 'new'], JSON.stringify(installed));
  assert.equal(installed.state, 'failed', JSON.stringify(installed));

  await page.evaluate(() => {
    window.agentStates = [];
    document.querySelector('slicc-app').show('updates');
  });
  const retry = () =>
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      ?.shadowRoot?.querySelector('article[data-id="agent"] swc-button[data-action="retry"]');
  await page.until(new Function(`return !!(${retry})()`));
  await page.evaluate(new Function(`(${retry})().click()`));
  await page
    .within(UPDATE, () => document.querySelector('slicc-app').model.updates.ready())
    .catch(async (error) => {
      throw new Error(`${error.message}\n${JSON.stringify(await row())}`);
    });
  const recovered = await row();
  assert.deepEqual(recovered.adapters, ['old', 'new'], JSON.stringify(recovered));
  assert.notEqual(recovered.state, 'failed', JSON.stringify(recovered));

  const seen = async (error) => {
    const chat = await page.evaluate(() =>
      window.chatView()
        ? window.deepText(window.chatView().shadowRoot).slice(-600)
        : 'no chat panel'
    );
    throw new Error(`${error.message}\n${JSON.stringify(await row())}\nchat: ${chat}`);
  };
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page
    .until(() => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea'))
    .catch(seen);
  await page.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
  await page.insert('Say hello');
  await page.enter();
  await page
    .until(() =>
      window.deepText(window.chatView().shadowRoot).includes('Hello from Bedrock in seven.')
    )
    .catch(seen);
  assert.deepEqual(page.errors, []);
});

test('a fresh profile’s first agent turn finds seven’s tools after boot: rg runs and curl reaches an https upstream, since the agent waits for them to settle', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(persisted);
  await page.init(storageStub);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page, undefined, { tools: false });
  await agentUp(page);
  await connectAccount(page, 'amazon-bedrock', KEY);
  await page.until(() =>
    document.querySelector('slicc-app').dock.api.panels.some((panel) => panel.id === 'chat:cone')
  );
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.until(
    () => !!window.chatView() && !!window.deep(window.chatView().shadowRoot, 'textarea')
  );
  const before = toolResults.length;
  await page.evaluate(() => window.deep(window.chatView().shadowRoot, 'textarea').focus());
  await page.insert(
    'RUN: rg --version | head -1 && curl -sI https://tools.example.test/ | tr -d "\\r"'
  );
  await page.enter();
  await eventually(() => toolResults.length > before, 120000);
  const result = toolResults[before];
  assert.match(result.text, /^ripgrep \d/m, JSON.stringify(result));
  assert.match(result.text, /^x-upstream: tools$/im, JSON.stringify(result));
  assert.notEqual(result.status, 'error', JSON.stringify(result));
});
