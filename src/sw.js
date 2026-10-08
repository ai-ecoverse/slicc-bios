import { createResolver, NODE_STUBS } from './sw/resolve.js';
import { nodeStub } from './sw/stubs.js';
import { transform } from './sw/transform.js';

const types = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
};

const isolation = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

const script = /\.(m?js|cjs)$/;
const markers = [
  '/var/lib/slicc/pnpm-lock.yaml',
  '/node_modules/.modules.yaml',
  '/var/lib/slicc/agent/pnpm-lock.yaml',
  '/opt/agent/node_modules/.modules.yaml',
];

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

async function rewrite(path, file, base) {
  const resolve = await currentResolver();
  const cached = transformed.get(path);
  if (cached?.stamp === file.lastModified) return cached.text;
  const text = await transform(path, await file.text(), { resolve, base });
  transformed.set(path, { stamp: file.lastModified, text });
  return text;
}

function respond(body, type, origin) {
  return new Response(body, {
    headers: { ...isolation, 'content-type': type, 'x-served-from': origin },
  });
}

async function serve(request) {
  const scope = new URL(self.registration.scope).pathname;
  const url = new URL(request.url);
  const asked = `/${url.pathname.slice(scope.length)}`;
  const path = asked === '/auth/callback' ? '/os/callback.html' : asked;
  const base = scope.replace(/\/$/, '');
  if (path.startsWith(NODE_STUBS)) {
    const name = path.slice(NODE_STUBS.length).replace(/\.js$/, '');
    const wanted = url.searchParams.get('names')?.split(',') ?? [];
    return respond(nodeStub(name, wanted), types.js, 'stub');
  }
  let file;
  try {
    file = await read(path);
  } catch {
    return fetch(request);
  }
  const extension = file.name.split('.').pop();
  const type = types[extension] ?? 'application/octet-stream';
  if (!script.test(file.name)) return respond(file, type, 'opfs');
  return respond(await rewrite(path, file, base), type, 'opfs');
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method === 'GET' && event.request.url.startsWith(self.registration.scope)) {
    event.respondWith(serve(event.request));
  }
});
