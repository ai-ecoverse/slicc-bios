const types = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
};

const isolation = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

async function read(path) {
  const names = path.split('/');
  const name = names.pop() || 'index.html';
  let dir = await navigator.storage.getDirectory();
  for (const part of names) dir = await dir.getDirectoryHandle(part);
  return (await dir.getFileHandle(name)).getFile();
}

async function serve(request) {
  const path = new URL(request.url).pathname.slice(
    new URL(self.registration.scope).pathname.length
  );
  try {
    const file = await read(path);
    const type = types[file.name.split('.').pop()] ?? 'application/octet-stream';
    return new Response(file, {
      headers: { ...isolation, 'content-type': type, 'x-served-from': 'opfs' },
    });
  } catch {
    return fetch(request);
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method === 'GET' && event.request.url.startsWith(self.registration.scope)) {
    event.respondWith(serve(event.request));
  }
});
