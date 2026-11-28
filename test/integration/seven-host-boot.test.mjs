import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer as createPlain, request } from 'node:http';
import { createServer } from 'node:https';
import { after, test } from 'node:test';
import { createTarDecoder } from 'modern-tar';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { IMS_ORIGINS } from '../../src/seed/adobe.js';
import { LOADER } from '../../src/seed/entry.js';
import { PREFIX } from '../../src/seed/handoff.js';
import { notSevenText } from '../../src/seed/seven-host.js';
import { AGENT, AGENT_REFUSED, MCP_CALLBACK } from '../../src/sw/agent.js';
import { BROWSERS, LOCK_CACHE, lockKey } from '../../src/sw/lock.js';
import { scanImports } from '../../src/sw/scan.js';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { certificate } from './real-extension.mjs';
import { errorsOf, observeNetwork, workerPath } from './seven-host-observation.mjs';

const PILOT = 'https://lease-pilot.sliccy.ai';
const SEVEN = 'https://seven.sliccy.ai';
const PREVIEW = 'https://bb-x.sliccy.ai';
const WWW = 'https://www.sliccy.ai';
const BOOT_MS = 10 * 60 * 1000;
const SRC = new URL('../../src/', import.meta.url);
const SEED = new URL('seed/', SRC);

const files = (dir) =>
  readdirSync(new URL(dir, SRC), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(`${dir}${entry.name}/`) : [`/${dir}${entry.name}`]
  );

function graph(starts) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!path.endsWith('.js')) continue;
    const at = new URL(`.${path}`, SRC);
    for (const { value } of scanImports(readFileSync(at, 'utf8'))) {
      if (!value.startsWith('.')) continue;
      queue.push(`/${new URL(value, at).href.slice(SRC.href.length)}`);
    }
  }
  return [...seen];
}

const lock = JSON.parse(readFileSync(new URL('packages/package-lock.json', SRC), 'utf8'));
const TAR = /const TAR = '([^']+)'/.exec(readFileSync(new URL('installer.js', SRC), 'utf8'))[1];
const NPM_INSTALLS = {
  tarballs: new Set(Object.values(lock.packages).flatMap(({ resolved }) => resolved ?? [])),
  unpacker: TAR.slice(0, TAR.indexOf('/dist/') + 1),
};
const npmInstall = (url) => NPM_INSTALLS.tarballs.has(url) || url.startsWith(NPM_INSTALLS.unpacker);

const CATALOG_JSON = '/node_modules/@ai-ecoverse/slicc-browsers/catalog.json';
const SWC_CSS = '/node_modules/@ai-ecoverse/slicc-spectrum/dist/swc.css';
const AGENT_CALLBACK = `${AGENT}node_modules/@ai-ecoverse/slicc-agent/dist/oauth/mcp-callback.html`;
const AGENT_ASSET = `${AGENT}asset.txt`;
const AGENT_ROUTES = [MCP_CALLBACK, AGENT_CALLBACK, AGENT_ASSET];
const UNAVAILABLE = 'sw: seven’s policy is unavailable. Reload through the BIOS.';
const ICONS = files('icons/');
const FONTS = ['/fonts/AdobeClean-Regular.otf', '/fonts/AdobeClean-Bold.otf'];
const NETWORK_ASSETS = new Set([
  ...ICONS,
  ...FONTS,
  '/manifest.json',
  '/os/favicon.svg',
  '/os/manifest.json',
  '/favicon.ico',
]);
const SW_GRAPH = new Set(graph(['/sw.js']));
const BIOS_PAGE = new Set([
  '/',
  '/index.html',
  '/bios.css',
  '/manifest.json',
  '/installer.js',
  '/sw.js',
  '/packages/package.json',
  ...ICONS,
  ...graph(['/sw/home.js', '/bios.js']),
]);
const INSTALLER = new Set([
  '/installer.js',
  '/sw/integrity.js',
  ...files('packages/'),
  ...files('seed/'),
]);
const OS_MODULES = ['/os/seven-host.js', '/os/handoff.js', '/os/seven-rule.js', CATALOG_JSON];
const ENTRY = {
  'index.html': new Set([
    '/os/',
    '/os/index.html',
    '/os/os.css',
    '/os/start.js',
    '/os/favicon.svg',
    '/os/manifest.json',
    '/icons/favicon.svg',
    '/manifest.json',
    ...OS_MODULES,
  ]),
  'join.html': new Set([
    '/os/join.html',
    '/os/join.css',
    '/os/join-start.js',
    '/os/entry.js',
    SWC_CSS,
    '/os/favicon.svg',
    '/icons/favicon.svg',
    ...FONTS,
    ...OS_MODULES,
  ]),
  'callback.html': new Set([
    '/auth/callback',
    '/os/callback.html',
    '/os/callback-start.js',
    '/os/entry.js',
    '/favicon.ico',
    ...OS_MODULES,
  ]),
  agent: new Set([MCP_CALLBACK, AGENT_CALLBACK, '/favicon.ico']),
};
const MUST_LOAD = {
  'index.html': ['/os/start.js', '/os/seven-host.js'],
  'join.html': ['/os/join-start.js', '/os/entry.js', '/os/seven-host.js'],
  'callback.html': ['/os/callback-start.js', '/os/entry.js', '/os/seven-host.js'],
  agent: [],
};

const hits = [];
let lockOffline = false;
const PROXIED = new Set(['lease-pilot.sliccy.ai', 'seven.sliccy.ai', 'bb-x.sliccy.ai']);
function proxy(req, res, path, extra = {}) {
  const upstream = new URL(chrome.url);
  const proxied = request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path,
      method: req.method,
      headers: { ...req.headers, host: upstream.host },
    },
    (answer) => {
      res.writeHead(answer.statusCode, { ...answer.headers, ...extra });
      answer.pipe(res);
    }
  );
  proxied.on('error', () => res.writeHead(502).end());
  req.pipe(proxied);
}
const front = createServer(await certificate(), (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  hits.push({
    host: url.host,
    path: url.pathname,
    method: req.method,
    destination: req.headers['sec-fetch-dest'],
    scriptQuery: url.pathname === '/sw.js' ? url.search : '',
  });
  if (lockOffline && url.origin === SEVEN && url.pathname === '/packages/package-lock.json') {
    req.socket.destroy();
    return;
  }
  if (PROXIED.has(url.host)) return proxy(req, res, req.url);
  if (url.host !== 'www.sliccy.ai') return res.writeHead(404).end();
  if (url.pathname === '/7') return res.writeHead(301, { location: '/7/' }).end();
  if (url.pathname.startsWith('/7/')) {
    const allowed = url.pathname === '/7/sw.js' ? { 'service-worker-allowed': '/' } : {};
    return proxy(req, res, req.url.slice(2), allowed);
  }
  if (url.pathname.startsWith('/fonts/')) return proxy(req, res, req.url);
  if (url.pathname.startsWith('/os/') && req.headers['sec-fetch-mode'] === 'navigate')
    return res.writeHead(302, { location: '/7/' }).end();
  return res.writeHead(404).end();
});
const reached = [];
const hub = createPlain((req, res) => {
  reached.push(`${req.method} ${req.url}`);
  res
    .writeHead(404, { 'access-control-allow-origin': '*', 'content-type': 'application/json' })
    .end('{}');
});
await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
const frontAt = `127.0.0.1:${front.address().port}`;
const mapped = ['*.sliccy.ai', 'sliccy.ai', ...IMS_ORIGINS.map((origin) => new URL(origin).host)];
const chrome = await launch({
  tools: false,
  vault: false,
  args: [
    '--ignore-certificate-errors',
    '--no-proxy-server',
    `--host-resolver-rules=${mapped.map((host) => `MAP ${host} ${frontAt}`).join(', ')}`,
  ],
});

const { sent, failures } = observeNetwork(chrome.cdp);
after(async () => {
  for (const server of [front, hub]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await chrome.close();
});

const JOIN = `http://127.0.0.1:${hub.address().port}/join/j1`;
const SEAT = `http://127.0.0.1:${hub.address().port}/join/g1`;
const mark = () => ({
  hits: hits.length,
  sent: sent.length,
  npm: chrome.cdn.requests.length,
  hub: reached.length,
});

function traffic(since, entry, { bios = false } = {}) {
  const own = ({ origin, method }) => origin === PILOT && method === 'GET';
  const page = new Set([...ENTRY[entry], ...(bios ? BIOS_PAGE : [])]);
  const network = new Set([
    ...SW_GRAPH,
    ...NETWORK_ASSETS,
    ...(bios ? [...BIOS_PAGE, ...INSTALLER] : []),
  ]);
  const line = ({ kind, method, url }) => `${kind} ${method} ${url}`;
  const window = sent.slice(since.sent);
  return {
    page: window
      .filter((seen) => seen.kind === 'page' && !(own(seen) && page.has(seen.path)))
      .map(line),
    installer: window
      .filter(
        (seen) =>
          seen.kind === 'shared_worker' &&
          !(bios && (npmInstall(seen.url) || (own(seen) && INSTALLER.has(seen.path))))
      )
      .map(line),
    worker: window
      .filter(
        (seen) =>
          seen.kind === 'service_worker' &&
          !(own(seen) && workerPath(seen.path, { network, installer: INSTALLER, bios }))
      )
      .map(line),
    others: window
      .filter(
        (seen) =>
          !seen.kind.startsWith('foreign ') &&
          !['page', 'shared_worker', 'service_worker'].includes(seen.kind)
      )
      .map(line),
    network: hits
      .slice(since.hits)
      .filter(
        ({ host, method, path }) =>
          host !== 'lease-pilot.sliccy.ai' || method !== 'GET' || !network.has(path)
      )
      .map(({ method, host, path }) => `${method} ${host}${path}`),
    npm: chrome.cdn.requests.slice(since.npm).filter((url) => !bios || !npmInstall(url)),
    hub: reached.slice(since.hub),
  };
}
const NOTHING_ELSE = {
  page: [],
  installer: [],
  worker: [],
  others: [],
  network: [],
  npm: [],
  hub: [],
};

function stored() {
  const cookie = document.cookie;
  const hex = async (bytes) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  const web = (storage) =>
    Promise.all(
      Object.keys(storage)
        .sort()
        .map(async (key) => [key, await hex(new TextEncoder().encode(storage.getItem(key)))])
    );
  const local = web(localStorage);
  const session = web(sessionStorage);
  const count = (name, version) =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open(name, version);
      open.onupgradeneeded = () => open.transaction.abort();
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const names = [...db.objectStoreNames];
        if (!names.length) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction(names, 'readonly');
        const counts = names.map((store) => [store, tx.objectStore(store).count()]);
        tx.oncomplete = () => {
          db.close();
          resolve(counts.map(([store, result]) => [store, result.result]));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  const idb = async () =>
    Promise.all(
      (await indexedDB.databases())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async ({ name, version }) => [name, await count(name, version)])
    );
  const cached = async () =>
    Promise.all(
      (await caches.keys())
        .sort()
        .map(async (name) => [name, (await (await caches.open(name)).keys()).length])
    );
  const databases = idb();
  const cacheCounts = cached();
  const walk = async (dir, prefix, out) => {
    for await (const [name, handle] of dir.entries()) {
      const path = `${prefix}${name}`;
      if (handle.kind === 'file')
        out.push(`${path} ${await hex(await (await handle.getFile()).arrayBuffer())}`);
      else {
        out.push(`${path}/`);
        if (path !== 'node_modules' && path !== 'opt') await walk(handle, `${path}/`, out);
      }
    }
    return out;
  };
  return (async () => ({
    opfs: (await walk(await navigator.storage.getDirectory(), '', [])).sort(),
    local: await local,
    session: await session,
    idb: await databases,
    caches: await cacheCounts,
    cookie,
  }))();
}
const storage = (page) => page.evaluate(stored);
const atStart = (page) => page.evaluate(() => window.sliccStoredAtStart ?? null);
const withoutHandOffs = (state) => ({
  ...state,
  local: state.local.filter(([key]) => !key.startsWith(PREFIX)),
});

async function shownOn(page) {
  await page.until(() => document.readyState === 'complete');
  return page.evaluate(() => {
    const box = document.querySelector('[data-refused]');
    return {
      refused: box?.dataset.refused ?? null,
      visible: Boolean(box?.checkVisibility()),
      text: box ? [...box.children].map((node) => `${node.localName}: ${node.textContent}`) : [],
      app: Boolean(document.querySelector('slicc-app')),
      chat: customElements.get('slicc-chat') !== undefined,
      frames: document.querySelectorAll('iframe').length,
      booted: ['users', 'tools', 'follow'].filter((key) => key in document.documentElement.dataset),
    };
  });
}
const REFUSED = {
  refused: 'not-seven',
  visible: true,
  text: ['h1: Seven doesn’t run here', `p: ${notSevenText(PILOT)}`],
  app: false,
  chat: false,
  frames: 0,
  booted: [],
};

const loadedOn = (since, entry) =>
  MUST_LOAD[entry].filter(
    (path) => !sent.slice(since.sent).some((seen) => seen.kind === 'page' && seen.path === path)
  );

const visible = () => !!document.querySelector('[data-refused]')?.checkVisibility();

const ENTRY_PAGES = readdirSync(SEED).filter((name) => name.endsWith('.html'));
const ROUTES = [
  ['/os/', 'index.html', '/os/'],
  ['/os/index.html', 'index.html', '/os/index.html'],
  ['/os/?x=1#y=2', 'index.html', '/os/'],
  [`/os/#follow=${encodeURIComponent(JOIN)}`, 'index.html', '/os/'],
  ['/os/join.html', 'join.html', '/os/join.html'],
  [`/os/join.html?straight#seat=${encodeURIComponent(SEAT)}`, 'join.html', '/os/join.html'],
  ['/auth/callback?nonce=n1#access_token=t0k3n&expires_in=60', 'callback.html', '/auth/callback'],
  [
    '/os/callback.html?nonce=n2#access_token=t0k3n&expires_in=60',
    'callback.html',
    '/os/callback.html',
  ],
];

const STAND_IN = `<!doctype html><title>stand-in</title><p>stand-in</p><script type="module">
const params = new URLSearchParams(location.search);
const state = params.get('state');
const named = localStorage.getItem('slicc-mcp-oauth:' + state);
localStorage.setItem('stand-in-ran', String(named));
new BroadcastChannel('slicc-mcp-oauth').postMessage({ code: params.get('code'), state, named });
</script>`;

async function plantAgent(page) {
  await page.evaluate(
    async (path, body, asset) => {
      let dir = await navigator.storage.getDirectory();
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writer = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writer.write(body);
      await writer.close();
      const agent = await (
        await (await navigator.storage.getDirectory()).getDirectoryHandle('opt')
      ).getDirectoryHandle('agent');
      const file = await (await agent.getFileHandle(asset, { create: true })).createWritable();
      await file.write('agent asset');
      await file.close();
      localStorage.setItem('slicc-mcp-oauth:s1', 'Docs server');
    },
    AGENT_CALLBACK,
    STAND_IN,
    AGENT_ASSET.split('/').at(-1)
  );
}

async function servedAgent(page, status, body) {
  for (const path of AGENT_ROUTES) {
    const seen = await page.evaluate(async (path) => {
      const response = await fetch(path, { cache: 'no-store' });
      return { status: response.status, body: (await response.text()).trim() };
    }, path);
    assert.deepEqual(
      seen,
      {
        status,
        body: body ?? (path === AGENT_ASSET ? 'agent asset' : STAND_IN),
      },
      path
    );
  }
}

async function staleCatalog() {
  const tarball = await download(
    'https://registry.npmjs.org/@ai-ecoverse/slicc-browsers/-/slicc-browsers-1.40.1.tgz'
  );
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const tar = new Blob([new Uint8Array(tarball)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(createTarDecoder());
  for await (const { header, body } of tar) {
    if (header.name === 'package/catalog.json') {
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      assert.ok(!JSON.parse(bytes).seven.excludedLabels.includes('lease-pilot'));
      return {
        integrity,
        bytes: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    await body.cancel();
  }
  assert.fail('slicc-browsers 1.40.1 did not contain catalog.json');
}

async function setCatalog(page, replacement) {
  await page.evaluate(
    async (path, source, replacement) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (
        await (await root.getDirectoryHandle('node_modules')).getDirectoryHandle('@ai-ecoverse')
      ).getDirectoryHandle('slicc-browsers');
      const file = await dir.getFileHandle('catalog.json');
      const before = await (await file.getFile()).text();
      const data = replacement
        ? Uint8Array.fromBase64(replacement.bytes)
        : before.replace('lease-pilot', 'lease-pilox');
      if (!replacement && data === before) throw new Error('catalog did not contain lease-pilot');
      const out = await file.createWritable();
      await out.write(data);
      await out.close();
      if (replacement) {
        const { openIntegrity } = await import('/sw/integrity.js');
        const ledger = await openIntegrity();
        await ledger.record(
          source,
          [{ path, size: data.byteLength, sha256: replacement.sha256 }],
          replacement.integrity
        );
      }
    },
    CATALOG_JSON,
    BROWSERS,
    replacement
  );
}

async function listen(page, channel) {
  await page.evaluate((channel) => {
    window.heard = [];
    window.channel = new BroadcastChannel(channel);
    window.channel.onmessage = ({ data }) => window.heard.push(data);
  }, channel);
}

async function sentinel(page, listener, channel, mark) {
  await page.evaluate(
    (channel, mark) => {
      window.sentinel = new BroadcastChannel(channel);
      window.sentinel.postMessage({ sentinel: mark });
    },
    channel,
    mark
  );
  await listener.until((mark) => window.heard.some((data) => data?.sentinel === mark), mark);
  return listener.evaluate(() => window.heard.splice(0));
}

test('seven on lease-pilot.sliccy.ai: every os/ entry and the agent refuse, and nothing goes out but the BIOS’s own files and its npm package installs', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  t.afterEach(async () => assert.deepEqual(await failures(), []));
  await page.init(`() => {
    const set = Storage.prototype.setItem;
    window.sliccSet = [];
    Storage.prototype.setItem = function (key, value) {
      window.sliccSet.push(key);
      return set.call(this, key, value);
    };
    if (/^\\/(?:os\\/|auth\\/callback)/.test(location.pathname)) window.sliccStoredAtStart = (${stored})();
  }`);
  let before;

  await t.test('every HTML entry in os/ has a route in the rows below', () => {
    assert.deepEqual(
      ENTRY_PAGES.filter((name) => !ROUTES.some(([, entry]) => entry === name)),
      []
    );
  });

  await t.test(
    'os/index.html (seven’s ordinary boot): the BIOS installs its npm packages, then the refusal shows; no kernel, tray, agent, sign-in or vault starts and nothing is stored',
    async () => {
      const since = mark();
      await page.goto(`${PILOT}/`);
      await page.within(
        BOOT_MS,
        () =>
          location.pathname === '/os/' &&
          !!document.querySelector('[data-refused]')?.checkVisibility()
      );
      assert.deepEqual(await failures(), []);
      before = await storage(page);
      const window = sent.slice(since.sent);
      assert.deepEqual(
        {
          shown: await shownOn(page),
          loaded: loadedOn(since, 'index.html'),
          stored: (await atStart(page)) ?? 'no snapshot',
          empty: [before.session, before.caches, before.cookie],
          observed: {
            document: window.some(({ kind, path }) => kind === 'page' && path === '/os/'),
            installer: window.some(({ kind, url }) => kind === 'shared_worker' && npmInstall(url)),
            seed: window.some(
              ({ kind, path }) => kind === 'shared_worker' && path.startsWith('/seed/')
            ),
          },
          traffic: traffic(since, 'index.html', { bios: true }),
        },
        {
          shown: REFUSED,
          loaded: [],
          stored: before,
          empty: [[], [[LOCK_CACHE, 3]], ''],
          observed: { document: true, installer: true, seed: true },
          traffic: NOTHING_ELSE,
        }
      );
      assert.deepEqual(errorsOf(page), []);
    }
  );

  await t.test(
    'a reload of the refused page refuses again with no npm request and nothing stored',
    async () => {
      const since = mark();
      await page.reload();
      await page.until(visible);
      assert.deepEqual(
        {
          shown: await shownOn(page),
          stored: await storage(page),
          document: sent
            .slice(since.sent)
            .some(({ kind, path }) => kind === 'page' && path === '/os/'),
          traffic: traffic(since, 'index.html'),
        },
        { shown: REFUSED, stored: before, document: true, traffic: NOTHING_ELSE }
      );
    }
  );

  await t.test(
    'the service worker: every route into every os/ entry ends on the refusal, loads only that entry’s check and stores nothing',
    async () => {
      for (const [route, entry, document] of ROUTES) {
        const since = mark();
        await page.goto(`${PILOT}${route}`);
        await page.until(visible);
        assert.deepEqual(
          {
            shown: await shownOn(page),
            loaded: loadedOn(since, entry),
            stored: await storage(page),
            document: sent
              .slice(since.sent)
              .some(({ kind, path }) => kind === 'page' && path === document),
            traffic: traffic(since, entry),
          },
          { shown: REFUSED, loaded: [], stored: before, document: true, traffic: NOTHING_ELSE },
          route
        );
      }
      assert.deepEqual(errorsOf(page), []);
    }
  );

  await t.test(
    'a kept follow on lease-pilot never loads the follower and never reaches the hub',
    async () => {
      const since = mark();
      await page.evaluate(
        (url) =>
          localStorage.setItem(
            'slicc-os.follow',
            JSON.stringify({ hub: new URL(url).origin, url })
          ),
        JOIN
      );
      await page.goto(`${PILOT}/os/`);
      await page.until(visible);
      const kept = await page.evaluate(
        (url) =>
          localStorage.getItem('slicc-os.follow') ===
          JSON.stringify({ hub: new URL(url).origin, url }),
        JOIN
      );
      await page.evaluate(() => localStorage.removeItem('slicc-os.follow'));
      assert.deepEqual(
        {
          shown: await shownOn(page),
          kept,
          stored: await storage(page),
          traffic: traffic(since, 'index.html'),
        },
        {
          shown: REFUSED,
          kept: true,
          stored: before,
          traffic: NOTHING_ELSE,
        }
      );
    }
  );

  await t.test(
    'the sign-in callback refused at /auth/callback and /os/callback.html hands no grant to a tab',
    async () => {
      const listener = await page.tab();
      await listener.goto(`${PILOT}/os/`);
      await listener.until(visible);
      await listen(listener, 'slicc-sign-in');
      for (const [route] of ROUTES.filter(([, entry]) => entry === 'callback.html')) {
        const since = mark();
        await page.goto(`${PILOT}${route}`);
        await page.until(visible);
        assert.deepEqual(
          {
            shown: await shownOn(page),
            heard: await sentinel(page, listener, 'slicc-sign-in', route),
            traffic: traffic(since, 'callback.html'),
          },
          { shown: REFUSED, heard: [{ sentinel: route }], traffic: NOTHING_ELSE },
          route
        );
      }
      await listener.close();
    }
  );

  await t.test(
    'the agent’s MCP sign-in callback, with an installed agent and a pending sign-in: the service worker refuses /oauth/mcp-callback and its own path with 403 and serves nothing, so nothing is read or broadcast',
    async () => {
      await plantAgent(page);
      const listener = await page.tab();
      await listener.goto(`${PILOT}/os/`);
      await listener.until(visible);
      await listen(listener, 'slicc-mcp-oauth');
      for (const route of [MCP_CALLBACK, AGENT_CALLBACK]) {
        const since = mark();
        await page.goto(`${PILOT}${route}?code=c1&state=s1`);
        await page.until(() => document.readyState === 'complete');
        assert.deepEqual(
          {
            status: await page.evaluate(
              () => performance.getEntriesByType('navigation')[0]?.responseStatus
            ),
            body: await page.evaluate(() => document.body.textContent.trim()),
            ran: await page.evaluate(() => localStorage.getItem('stand-in-ran')),
            pending: await page.evaluate(
              () => localStorage.getItem('slicc-mcp-oauth:s1') === 'Docs server'
            ),
            heard: await sentinel(page, listener, 'slicc-mcp-oauth', route),
            traffic: traffic(since, 'agent'),
          },
          {
            status: 403,
            body: AGENT_REFUSED,
            ran: null,
            pending: true,
            heard: [{ sentinel: route }],
            traffic: NOTHING_ELSE,
          },
          route
        );
      }
      await listener.close();
      await page.goto(`${PILOT}/os/`);
      await page.until(visible);
      await page.evaluate(() => localStorage.removeItem('slicc-mcp-oauth:s1'));
      assert.deepEqual((await storage(page)).local, before.local);
    }
  );

  await t.test(
    'hand-offs: a #slicc-pair or #tailscale link, kept by the BIOS page or by os/index.html before any check, is removed by the refusal',
    async () => {
      for (const [route, bios] of [
        ['/#slicc-pair=p1&tailscale=t1&exit=e1', true],
        ['/os/index.html#slicc-pair=p2', false],
      ]) {
        const since = mark();
        await page.goto(`${PILOT}${route}`);
        await page.within(
          bios ? BOOT_MS : 30000,
          () =>
            location.pathname.startsWith('/os/') &&
            !!document.querySelector('[data-refused]')?.checkVisibility()
        );
        const start = await atStart(page);
        const after = await storage(page);
        const set = await page.evaluate(() => window.sliccSet);
        assert.deepEqual(
          {
            kept: new Set(
              [...(start?.local ?? []).map(([key]) => key), ...set].filter((key) =>
                key.startsWith(PREFIX)
              )
            ).size,
            shown: await shownOn(page),
            hash: await page.evaluate(() => location.hash),
            stored: after,
            worker: bios
              ? sent
                  .slice(since.sent)
                  .some(({ kind, path }) => kind === 'service_worker' && path === '/bios.js')
              : true,
            traffic: traffic(since, 'index.html', { bios }),
          },
          {
            kept: 1,
            shown: REFUSED,
            hash: '',
            stored: withoutHandOffs(start),
            worker: true,
            traffic: NOTHING_ELSE,
          },
          route
        );
      }
    }
  );

  await t.test(
    'a guest link through the BIOS: the refusal shows, no seat is kept and the hub is never reached',
    async () => {
      const since = mark();
      await page.goto(`${PILOT}/#seat=${encodeURIComponent(SEAT)}`);
      await page.within(
        BOOT_MS,
        () =>
          location.pathname === '/os/join.html' &&
          !!document.querySelector('[data-refused]')?.checkVisibility()
      );
      assert.deepEqual(
        {
          shown: await shownOn(page),
          loaded: loadedOn(since, 'join.html'),
          stored: await storage(page),
          traffic: traffic(since, 'join.html', { bios: true }),
        },
        {
          shown: REFUSED,
          loaded: [],
          stored: (await atStart(page)) ?? 'no snapshot',
          traffic: NOTHING_ELSE,
        }
      );
      assert.deepEqual(errorsOf(page), []);
    }
  );

  await t.test(
    'an installed catalog from slicc-browsers 1.40.1 is refused until the BIOS refresh',
    async () => {
      await setCatalog(page, await staleCatalog());
      await servedAgent(page, 503, UNAVAILABLE);
      await page.goto(`${PILOT}/`);
      await page.within(BOOT_MS, visible);
      await servedAgent(page, 403, AGENT_REFUSED);
    }
  );
});

async function booted(page, origin) {
  await ready(page, undefined, { tools: false });
  return page
    .evaluate(() => ({
      origin: location.origin,
      refused: document.querySelector('[data-refused]')?.dataset.refused ?? null,
      app: Boolean(document.querySelector('slicc-app')),
    }))
    .then((seen) => assert.deepEqual(seen, { origin, refused: null, app: true }));
}

async function watchVersions(page, t) {
  const updates = new EventEmitter();
  const versions = new Map();
  const transitions = [];
  const errors = [];
  const stop = chrome.cdp.on(({ method, params }) => {
    if (method === 'ServiceWorker.workerErrorReported') {
      const { versionId, errorMessage, sourceURL, lineNumber } = params.errorMessage;
      errors.push({ versionId, errorMessage, sourceURL, lineNumber });
    }
    if (method !== 'ServiceWorker.workerVersionUpdated') return;
    for (const version of params.versions) {
      const { versionId, scriptURL, status, runningStatus } = version;
      if (URL.parse(scriptURL)?.origin !== SEVEN) continue;
      const before = versions.get(versionId);
      if (before?.status !== status || before?.runningStatus !== runningStatus)
        transitions.push({ versionId, scriptURL, status, runningStatus });
      versions.set(versionId, version);
    }
    updates.emit('versions');
  });
  t.after(stop);
  await page.send('ServiceWorker.enable');
  const evidence = (since = 0, after = 0) => ({
    transitions: transitions.slice(after),
    workerErrors: errors.filter(({ versionId }) => versions.has(versionId)),
    updateConsole: page.console.filter((text) =>
      /didn.t update|ServiceWorker cannot be started/.test(text)
    ),
    requests: hits
      .slice(since)
      .filter(
        ({ host, path }) =>
          host === new URL(SEVEN).host &&
          (SW_GRAPH.has(path) || path === '/packages/package-lock.json')
      )
      .slice(-60)
      .map(({ path, destination, scriptQuery }) => [path + scriptQuery, destination]),
  });
  const wait = async (description, matches) => {
    const signal = AbortSignal.timeout(30000);
    try {
      for (;;) {
        const found = [...versions.values()].find(matches);
        if (found) return found;
        await once(updates, 'versions', { signal });
      }
    } catch (error) {
      throw new Error(`waiting for ${description}: ${JSON.stringify(evidence(hits.length))}`, {
        cause: error,
      });
    }
  };
  return {
    evidence,
    mark: () => transitions.length,
    async stop(status) {
      const { versionId, runningStatus } = await wait(
        `the ${status} /sw.js version`,
        (version) => version.status === status && version.scriptURL === `${SEVEN}/sw.js`
      );
      if (runningStatus !== 'stopped') await page.send('ServiceWorker.stopWorker', { versionId });
      await wait(
        `version ${versionId} to stop`,
        (version) => version.versionId === versionId && version.runningStatus === 'stopped'
      );
    },
  };
}

async function moduleReleaseResult(page, probe) {
  await page.goto(`${SEVEN}/`);
  await booted(page, SEVEN);
  return page.evaluate(async (probe) => {
    const stub = await (await fetch('/__slicc/node/fs.js')).text();
    const worker = new URL(navigator.serviceWorker.controller.scriptURL);
    return { probe: stub.includes(probe), worker: worker.pathname + worker.search };
  }, probe);
}

async function releaseUpdate(page, edition) {
  const worker = readFileSync(new URL('sw.js', SRC), 'utf8');
  const waiting = worker.replace('.then(() => self.skipWaiting())', '');
  assert.notEqual(waiting, worker);
  chrome.overrides.set('/sw.js', `${waiting}${'\n'.repeat(edition)}`);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    window.pendingWorker = null;
    registration.addEventListener(
      'updatefound',
      () => {
        window.pendingWorker = registration.installing;
      },
      { once: true }
    );
    await registration.update();
    window.pendingWorker ??= registration.installing ?? registration.waiting;
  });
}

const workerState = (page, state) =>
  page.within(30000, (state) => window.pendingWorker?.state === state, state);
const activateWorker = async (page) => {
  await page.evaluate(() => window.pendingWorker.postMessage({ activate: 'now' }));
  await workerState(page, 'activated');
};
const workerKey = (name) => lockKey(`${SEVEN}/sw.js`, name);
const readPointer = (page, name) =>
  page.evaluate(
    async (cache, key) => (await (await caches.open(cache)).match(key))?.json(),
    LOCK_CACHE,
    workerKey(name)
  );
const lockEntry = (page, name, action, value) =>
  page.evaluate(
    async (cache, key, action, value) => {
      const stored = await caches.open(cache);
      if (action === 'save') return stored.put(key, Response.json(value));
      if (action === 'delete') return stored.delete(key);
      return Boolean(await stored.match(key));
    },
    LOCK_CACHE,
    workerKey(name),
    action,
    value
  );

test('the service worker keeps its active release lock through updates and restarts', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  t.after(() => {
    lockOffline = false;
    chrome.overrides.delete('/sw.js');
    chrome.overrides.delete('/packages/package-lock.json');
  });
  await page.goto(`${SEVEN}/`);
  await booted(page, SEVEN);
  await page.within(5 * 60 * 1000, () =>
    document.querySelector('slicc-app')?.model.updates.ready()
  );
  await plantAgent(page);
  await page.goto(`${SEVEN}/manifest.json`);
  const { stop } = await watchVersions(page, t);
  const original = await readPointer(page, 'active');
  assert.ok(original?.id);

  await t.test('an offline restart keeps serving the callback and agent assets', async () => {
    lockOffline = true;
    try {
      await page.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await page.until(() => !navigator.onLine);
      await stop('activated');
      const since = hits.length;
      await servedAgent(page, 200);
      assert.ok(!hits.slice(since).some(({ path }) => path === '/packages/package-lock.json'));
    } finally {
      await page.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      lockOffline = false;
    }
  });

  await t.test('a missing, foreign or tampered active lock produces the fixed 503', async () => {
    await lockEntry(page, 'active', 'delete');
    await servedAgent(page, 503, UNAVAILABLE);
    await lockEntry(page, 'active', 'save', { ...original, id: crypto.randomUUID() });
    await servedAgent(page, 503, UNAVAILABLE);
    await lockEntry(page, 'active', 'save', { ...original, digest: '0'.repeat(64) });
    await servedAgent(page, 503, UNAVAILABLE);
    await lockEntry(page, 'active', 'save', original);
    await servedAgent(page, 200);
  });

  await t.test(
    'a malformed release lock fails installation and leaves the active copy intact',
    async () => {
      chrome.overrides.set('/packages/package-lock.json', '{invalid');
      await releaseUpdate(page, 1);
      await workerState(page, 'redundant');
      assert.deepEqual(await readPointer(page, 'active'), original);
      assert.ok(await lockEntry(page, original.id, 'exists'));
      await servedAgent(page, 200);
    }
  );

  await t.test(
    'a waiting release stages its own lock and leaves the active policy in service',
    async () => {
      const packages = {
        ...lock.packages,
        [BROWSERS]: {
          ...lock.packages[BROWSERS],
          integrity: `sha512-${Buffer.alloc(64, 123).toString('base64')}`,
        },
      };
      chrome.overrides.set('/packages/package-lock.json', JSON.stringify({ ...lock, packages }));
      await releaseUpdate(page, 2);
      await workerState(page, 'installed');
      assert.notEqual((await readPointer(page, 'staged')).id, original.id);
      assert.deepEqual(await readPointer(page, 'active'), original);
      await servedAgent(page, 200);
    }
  );

  let active;
  await t.test(
    'a new waiting release replaces abandoned staging and activates its own lock after a restart',
    async () => {
      const abandoned = await readPointer(page, 'staged');
      await releaseUpdate(page, 3);
      await workerState(page, 'installed');
      const staged = await readPointer(page, 'staged');
      assert.notEqual(staged.id, abandoned.id);
      assert.deepEqual(await readPointer(page, 'active'), original);
      await servedAgent(page, 200);
      await stop('installed');
      await activateWorker(page);
      active = await readPointer(page, 'active');
      assert.deepEqual(active, staged);
      assert.equal(await lockEntry(page, original.id, 'exists'), false);
      await servedAgent(page, 503, UNAVAILABLE);
    }
  );

  await t.test(
    'activation after a restart rejects a tampered staged copy and preserves the previous pointer',
    async () => {
      assert.ok(active?.id);
      chrome.overrides.delete('/packages/package-lock.json');
      await releaseUpdate(page, 4);
      await workerState(page, 'installed');
      const staged = await readPointer(page, 'staged');
      await lockEntry(page, staged.id, 'save', { invalid: true });
      await stop('installed');
      await activateWorker(page);
      assert.deepEqual(await readPointer(page, 'active'), active);
      assert.ok(await lockEntry(page, active.id, 'exists'));
      await servedAgent(page, 503, UNAVAILABLE);
    }
  );
});

test('seven, www.sliccy.ai/7/ and a bb-* preview boot as before through the same entries, run the agent’s callback, and recover from a page whose code failed to load', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  await t.test(
    'seven.sliccy.ai boots to its terminal, and its service worker still serves the agent’s MCP callback',
    async (t) => {
      const page = await chrome.page(t);
      await page.goto(`${SEVEN}/`);
      await booted(page, SEVEN);
      await page.within(5 * 60 * 1000, () =>
        document.querySelector('slicc-app')?.model.updates.ready()
      );
      await plantAgent(page);
      await servedAgent(page, 200);
      const listener = await page.tab();
      await listener.goto(`${SEVEN}/os/`);
      await listener.until(() => !!document.querySelector('slicc-app'));
      await listen(listener, 'slicc-mcp-oauth');
      await page.goto(`${SEVEN}${MCP_CALLBACK}?code=c1&state=s1`);
      await page.until(() => localStorage.getItem('stand-in-ran') === 'Docs server');
      await listener.until(() => window.heard.length > 0);
      assert.deepEqual(
        {
          heard: await listener.evaluate(() => window.heard),
        },
        { heard: [{ code: 'c1', state: 's1', named: 'Docs server' }] }
      );
      await listener.close();
      await setCatalog(page);
      await servedAgent(page, 503, UNAVAILABLE);
      await page.goto(`${SEVEN}/`);
      await booted(page, SEVEN);
      await page.within(5 * 60 * 1000, () =>
        document.querySelector('slicc-app')?.model.updates.ready()
      );
      await plantAgent(page);
      await servedAgent(page, 200);
    }
  );

  await t.test('a bb-* preview boots to its terminal', async (t) => {
    const page = await chrome.page(t);
    await page.goto(`${PREVIEW}/`);
    await booted(page, PREVIEW);
  });

  await t.test('a first-module release updates seven in place at /sw.js', async (t) => {
    const page = await chrome.page(t);
    await page.goto(`${SEVEN}/`);
    await booted(page, SEVEN);
    await page.within(BOOT_MS, () => document.querySelector('slicc-app')?.model.updates.ready());
    const integrity = readFileSync(new URL('sw/integrity.js', SRC), 'utf8');
    const stubs = readFileSync(new URL('sw/stubs.js', SRC), 'utf8');
    const probe = 'module-only release probe';
    const trace = await watchVersions(page, t);
    const before = sent.length;
    const since = hits.length;
    const baseline = trace.mark();
    const firstUrl = [...SW_GRAPH].filter((path) => path !== '/sw.js').sort()[0];
    chrome.overrides.set('/sw/integrity.js', `${integrity}\nexport const PROBE = 1;\n`);
    chrome.overrides.set('/sw/stubs.js', stubs.replace('is not available in the browser', probe));
    try {
      const served = await moduleReleaseResult(page, probe).catch((error) => {
        t.diagnostic(JSON.stringify({ firstUrl, ...trace.evidence(since, baseline) }));
        throw error;
      });
      const attempt = trace.evidence(since, baseline);
      if (served.worker !== '/sw.js' && firstUrl !== '/sw/integrity.js') {
        const controlSince = hits.length;
        const controlBaseline = trace.mark();
        const control = 'comparison from the first module URL';
        const firstSource = readFileSync(new URL(`.${firstUrl}`, SRC), 'utf8');
        chrome.overrides.set(firstUrl, `${firstSource}\nexport const RELEASE_PROBE = 1;\n`);
        chrome.overrides.set(
          '/sw/stubs.js',
          stubs.replace('is not available in the browser', control)
        );
        const result = await moduleReleaseResult(page, control).catch((error) => ({
          error: error.message,
        }));
        t.diagnostic(
          JSON.stringify({
            changedFirstModule: firstUrl,
            controlStart: served.worker,
            controlResult: result,
            ...trace.evidence(controlSince, controlBaseline),
          })
        );
      }
      assert.deepEqual(
        served,
        { probe: true, worker: '/sw.js' },
        JSON.stringify({ firstUrl, ...attempt })
      );
      assert.ok(!sent.slice(before).some(({ url }) => url === `${SEVEN}/sw.js?afresh`));
    } finally {
      chrome.overrides.delete('/sw/integrity.js');
      chrome.overrides.delete('/sw/stubs.js');
      chrome.overrides.delete(firstUrl);
    }
  });

  await t.test('www.sliccy.ai/7/ boots to its terminal', async (t) => {
    const page = await chrome.page(t);
    await page.goto(`${WWW}/7/`);
    await booted(page, WWW);
  });

  await t.test(
    'on seven, a guest page whose code was changed shows a refusal with Reload, not a loading page, and Reload through the BIOS puts the file back and opens it',
    async (t) => {
      const page = await chrome.page(t);
      await page.goto(`${SEVEN}/`);
      await booted(page, SEVEN);
      await page.evaluate(async () => {
        const os = await (await navigator.storage.getDirectory()).getDirectoryHandle('os');
        const handle = await os.getFileHandle('join.js');
        const writer = await handle.createWritable({ keepExistingData: true });
        await writer.seek((await handle.getFile()).size);
        await writer.write('\nglobalThis.changed = 1;\n');
        await writer.close();
      });
      const since = mark();
      await page.goto(`${SEVEN}/os/join.html#seat=${encodeURIComponent(SEAT)}`);
      await page.until(visible);
      const shown = await shownOn(page);
      await page.evaluate(() => document.querySelector('[data-refused] button').click());
      await page.within(
        BOOT_MS,
        () =>
          location.pathname === '/os/join.html' && customElements.get('slicc-chat') !== undefined
      );
      const restored = await page.evaluate(async () => {
        const os = await (await navigator.storage.getDirectory()).getDirectoryHandle('os');
        return (await (await os.getFileHandle('join.js')).getFile()).text();
      });
      assert.deepEqual(
        {
          shown,
          restored: restored.includes('globalThis.changed'),
          bios: sent
            .slice(since.sent)
            .some(({ kind, path }) => kind === 'page' && path === '/bios.js'),
        },
        {
          shown: {
            refused: 'loader',
            visible: true,
            text: ['h1: Seven couldn’t open this page', `p: ${LOADER}`, 'button: Reload'],
            app: false,
            chat: false,
            frames: 0,
            booted: [],
          },
          restored: false,
          bios: true,
        }
      );
    }
  );
});
