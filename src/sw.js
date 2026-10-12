import { kernelPort, loopback, Unreachable } from './sw/loopback.js';
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
  'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
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
const markers = [
  '/var/lib/slicc/pnpm-lock.yaml',
  '/node_modules/.modules.yaml',
  '/var/lib/slicc/agent/pnpm-lock.yaml',
  '/opt/agent/node_modules/.modules.yaml',
];
const AGENT = '/opt/agent/';

async function read(path) {
  const names = path.split('/').filter(Boolean);
  const name = path.endsWith('/') || names.length === 0 ? 'index.html' : names.pop();
  let dir = await navigator.storage.getDirectory();
  for (const part of names) dir = await dir.getDirectoryHandle(part);
  return (await dir.getFileHandle(name)).getFile();
}

const opfs = {
  readText: (path) =>
    read(path).then(
      (file) => file.text(),
      () => undefined
    ),
  isFile: (path) =>
    read(path).then(
      () => true,
      () => false
    ),
};

let generation;
let resolver;
const transformed = new Map();

async function currentResolver() {
  const times = await Promise.all(
    markers.map((marker) =>
      read(marker).then(
        (file) => file.lastModified,
        () => 0
      )
    )
  );
  const stamp = times.join(':');
  if (stamp !== generation) {
    generation = stamp;
    resolver = createResolver(opfs);
    transformed.clear();
  }
  return resolver;
}

async function rewrite(path, file, base, run) {
  const resolve = await currentResolver();
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
  if (served === 'stub') {
    const name = path.slice(NODE_STUBS.length).replace(/\.js$/, '');
    const wanted = url.searchParams.get('names')?.split(',') ?? [];
    return respond(nodeStub(name, wanted), types.js, 'stub');
  }
  if (served === 'sandboxed' && code.has(request.destination)) {
    return sandboxed(`sw: ${path} is not served as code\n`, 'text/plain; charset=utf-8', 403);
  }
  let file;
  try {
    file = await read(path);
  } catch {
    return network();
  }
  const extension = file.name.split('.').pop();
  if (served === 'sandboxed') {
    return sandboxed(file, inert[extension] ?? types[extension] ?? 'application/octet-stream');
  }
  const type = types[extension] ?? 'application/octet-stream';
  if (!script.test(file.name)) return respond(file, type, 'opfs');
  const run = path.startsWith(AGENT) ? url.searchParams.get('run') : null;
  return respond(await rewrite(path, file, base, run), type, 'opfs');
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
