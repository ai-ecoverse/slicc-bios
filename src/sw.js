import { appendLog, described, openIntegrity, sha256, treeOf } from './sw/integrity.js';
import { kernelPort, loopback, Unreachable } from './sw/loopback.js';
import { joined, opfsReader } from './sw/opfs.js';
import { createResolver, NODE_STUBS } from './sw/resolve.js';
import { nodeStub } from './sw/stubs.js';
import { transform } from './sw/transform.js';

const types = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  ts: 'text/javascript; charset=utf-8',
  mts: 'text/javascript; charset=utf-8',
  cts: 'text/javascript; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
};

const isolation = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
};

const script = /\.[cm]?[jt]s$/;
const inert = {
  ...Object.fromEntries(
    ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((extension) => [
      extension,
      'text/plain; charset=utf-8',
    ])
  ),
  wasm: 'application/octet-stream',
};
const sandbox = {
  'content-security-policy':
    "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};
const code = new Set([
  'script',
  'worker',
  'sharedworker',
  'serviceworker',
  'audioworklet',
  'paintworklet',
  'xslt',
]);
const live = ['/os/', '/node_modules/', '/opt/agent/', '/opt/grammars/'];
const own = new Set([
  '/',
  '/index.html',
  '/bios.js',
  '/bios.css',
  '/installer.js',
  '/sw.js',
  '/manifest.json',
]);
const ownDirs = ['/sw/', '/seed/', '/packages/', '/icons/', '/fonts/'];

function kind(path) {
  if (own.has(path) || ownDirs.some((dir) => path.startsWith(dir))) return 'bios';
  if (path.startsWith(NODE_STUBS)) return 'stub';
  return live.some((dir) => path.startsWith(dir)) ? 'live' : 'sandboxed';
}
const markers = {
  base: ['/var/lib/slicc/pnpm-lock.yaml', '/node_modules/.modules.yaml'],
  agent: ['/var/lib/slicc/agent/pnpm-lock.yaml', '/opt/agent/node_modules/.modules.yaml'],
};
const AGENT = '/opt/agent/';

const read = opfsReader();

class Changed extends Error {
  constructor(path, what, hashes = {}) {
    super(`sw: ${path} ${what}`);
    this.path = path;
    this.hashes = hashes;
    this.recorded = what.endsWith('installed it');
  }
}

let ledger;
const trusted = new Set();
const HEAL_GAP = 60000;
const STATUS = '/__slicc/integrity';
const healed = new Map();

function integrity() {
  ledger ??= openIntegrity();
  return ledger;
}

async function checked(path, file) {
  const tree = treeOf(path);
  if (!tree) return file;
  const key = `${path}\n${file.size}\n${file.lastModified}`;
  if (trusted.has(key)) return file;
  const store = await integrity();
  if (!(await store.generation(tree))) throw new Changed(path, "isn't verified yet");
  const record = await store.lookup(path);
  const bytes = await file.arrayBuffer();
  const actual = await sha256(bytes);
  if (record?.size !== bytes.byteLength || record.sha256 !== actual) {
    throw new Changed(path, 'was changed after seven installed it', {
      expected: record?.sha256 ?? null,
      actual,
    });
  }
  trusted.add(key);
  return new File([bytes], file.name, { lastModified: file.lastModified });
}

async function missing(path) {
  const record = treeOf(path) && (await (await integrity()).lookup(path));
  if (record) {
    throw new Changed(path, 'was removed after seven installed it', {
      expected: record.sha256,
      actual: null,
    });
  }
}

async function updating() {
  const { held = [] } = (await navigator.locks?.query()) ?? {};
  return held.some(({ name }) => name === 'slicc-packages');
}

async function heal(scope, path) {
  if (Date.now() - (healed.get(path) ?? 0) < HEAL_GAP) return;
  healed.set(path, Date.now());
  const windows = await self.clients.matchAll({ type: 'window' });
  for (const client of windows) {
    const { pathname, hash } = new URL(client.url);
    if (pathname === `${scope}os/` || pathname === `${scope}os/index.html`) {
      client.navigate(`${self.registration.scope}${hash}`).catch(() => {});
    }
  }
}

async function stop(path) {
  const windows = await self.clients.matchAll({ type: 'window' });
  for (const client of windows) client.postMessage({ integrity: { stopped: path } });
}

async function refuse(error, request, scope) {
  if (!(error instanceof Changed)) throw error;
  if (await updating()) return failed(503, `sw: seven is updating ${error.path}, try again`);
  if (error.recorded) {
    const { fresh, stopped, entry } = await (await integrity()).tamper(error.path, error.hashes);
    if (fresh) {
      await appendLog(
        navigator.storage.getDirectory(),
        described(entry, stopped ? 'stopped' : 'changed')
      );
    }
    if (stopped) {
      if (fresh) await stop(error.path);
      return failed(500, `sw: ${error.path} keeps changing, so seven stopped restoring it`);
    }
  }
  if (request.mode === 'navigate') return Response.redirect(self.registration.scope, 302);
  await heal(scope, error.path);
  return failed(500, error.message);
}

const opfs = {
  readText: async (path) => {
    let file;
    try {
      file = await read(path);
    } catch {
      await missing(path);
      return undefined;
    }
    return (await checked(path, file)).text();
  },
  isFile: (path) =>
    read(path).then(
      () => true,
      () => false
    ),
};

const stamps = { base: null, agent: null };
const resolvers = { base: null, agent: null };
const transformed = new Map();

const currentResolvers = joined(freshResolvers);

async function stamp(list) {
  const times = await Promise.all(
    list.map((marker) =>
      read(marker).then(
        (file) => file.lastModified,
        () => 0
      )
    )
  );
  return times.join(':');
}

async function freshResolvers() {
  const [base, agent] = await Promise.all([stamp(markers.base), stamp(markers.agent)]);
  if (base !== stamps.base) {
    resolvers.base = createResolver(opfs);
    resolvers.agent = createResolver(opfs);
    transformed.clear();
  } else if (agent !== stamps.agent) {
    resolvers.agent = createResolver(opfs);
    for (const key of transformed.keys()) if (key.startsWith(AGENT)) transformed.delete(key);
  }
  Object.assign(stamps, { base, agent });
  return resolvers;
}

async function rewrite(path, file, base, run) {
  const resolve = (await currentResolvers())[path.startsWith(AGENT) ? 'agent' : 'base'];
  const query = run ? `?run=${encodeURIComponent(run)}` : '';
  const key = `${path}${query}`;
  const cached = transformed.get(key);
  if (cached?.stamp === file.lastModified) return cached.text;
  const suffix = (target) => (target.startsWith(AGENT) ? query : '');
  const text = await transform(path, await file.text(), { resolve, base, suffix });
  transformed.set(key, { stamp: file.lastModified, text });
  return text;
}

function respond(body, type, origin, status = 200) {
  return new Response(body, {
    status,
    headers: { ...isolation, 'content-type': type, 'x-served-from': origin },
  });
}

const PATIENCE = 30000;

function failed(status, text) {
  return respond(`${text}\n`, 'text/plain; charset=utf-8', 'sw', status);
}

function sandboxed(body, type, status = 200) {
  return new Response(body, {
    status,
    headers: { ...sandbox, 'content-type': type, 'x-served-from': 'opfs' },
  });
}

function deadline(text) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(text)), PATIENCE);
  });
  return { late, clear: () => clearTimeout(timer) };
}

function watched(response, pathname, controller) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(stream) {
      const idle = deadline(`sw: no data for ${pathname} in ${PATIENCE / 1000} s`);
      try {
        const { done, value } = await Promise.race([reader.read(), idle.late]);
        if (done) stream.close();
        else stream.enqueue(value);
      } catch (error) {
        controller.abort();
        reader.cancel(error).catch(() => {});
        stream.error(error);
      } finally {
        idle.clear();
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, response);
}

function answer(request, work, from = '') {
  const { pathname } = new URL(request.url);
  const controller = new AbortController();
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(failed(504, `sw: no answer${from} for ${pathname} in ${PATIENCE / 1000} s`));
    }, PATIENCE);
  });
  const served = work(request, controller).catch((error) =>
    error instanceof Unreachable
      ? failed(502, `sw: ${error.message}`)
      : failed(502, `sw: ${pathname} failed: ${error.message}`)
  );
  return Promise.race([served, late]).finally(() => clearTimeout(timer));
}

async function kernel(request, controller, port, clientId) {
  const { pathname } = new URL(request.url);
  const response = await loopback(request, port, {
    clients: self.clients,
    clientId,
    scope: new URL(self.registration.scope).pathname,
    origin: self.location.origin,
  });
  if (controller.signal.aborted) {
    await response.body?.cancel();
    return response;
  }
  return watched(response, pathname, controller);
}

const aliases = new Map([
  ['/auth/callback', '/os/callback.html'],
  [
    '/oauth/mcp-callback',
    '/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/oauth/mcp-callback.html',
  ],
]);

async function serve(request, controller) {
  const scope = new URL(self.registration.scope).pathname;
  const url = new URL(request.url);
  const asked = `/${url.pathname.slice(scope.length)}`;
  const path = aliases.get(asked) ?? asked;
  const base = scope.replace(/\/$/, '');
  const network = async () =>
    watched(await fetch(request, { signal: controller.signal }), url.pathname, controller);
  const served = kind(path);
  if (served === 'bios') return network();
  if (path === STATUS) {
    const stopped = await (await integrity()).stopped();
    return respond(JSON.stringify({ stopped }), types.json, 'sw');
  }
  if (served === 'stub') {
    const name = path.slice(NODE_STUBS.length).replace(/\.js$/, '');
    const wanted = url.searchParams.get('names')?.split(',') ?? [];
    return respond(nodeStub(name, wanted), types.js, 'stub');
  }
  if (served === 'sandboxed' && code.has(request.destination)) {
    return sandboxed(`sw: ${path} is not served as code\n`, 'text/plain; charset=utf-8', 403);
  }
  const at = path.endsWith('/') ? `${path}index.html` : path;
  let file;
  try {
    file = await read(path);
  } catch {
    const gone =
      served === 'live'
        ? await missing(at).then(
            () => null,
            (error) => error
          )
        : null;
    return gone ? refuse(gone, request, scope) : network();
  }
  const extension = file.name.split('.').pop();
  if (served === 'sandboxed') {
    return sandboxed(file, inert[extension] ?? types[extension] ?? 'application/octet-stream');
  }
  const type = types[extension] ?? 'application/octet-stream';
  try {
    file = await checked(at, file);
    if (!script.test(file.name)) return respond(file, type, 'opfs');
    const run = path.startsWith(AGENT) ? url.searchParams.get('run') : null;
    return respond(await rewrite(path, file, base, run), type, 'opfs');
  } catch (error) {
    return refuse(error, request, scope);
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const { request, clientId } = event;
  const port = kernelPort(request.url);
  if (port) {
    event.respondWith(
      answer(
        request,
        (asked, controller) => kernel(asked, controller, port, clientId),
        ` from kernel port ${port}`
      )
    );
  } else if (request.method === 'GET' && request.url.startsWith(self.registration.scope)) {
    event.respondWith(answer(request, serve));
  }
});
