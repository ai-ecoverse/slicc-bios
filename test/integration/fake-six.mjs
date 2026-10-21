import { createServer } from 'node:http';

export const SIX_TYPE = 'slicc-six-upgrade';
export const STOP_ERROR = "A SLICC 6 tab didn't stop. Close your SLICC 6 tabs and try again.";

export const sixPage = `<!doctype html>
<title>SLICC 6</title>
<p id="six">six</p>
<script>
(async () => {
  const six = document.getElementById('six');
  const root = await navigator.storage.getDirectory();
  const fs = await root.getDirectoryHandle('slicc-fs', { create: true });
  const home = await fs.getDirectoryHandle('home', { create: true });
  const user = await home.getDirectoryHandle('user', { create: true });
  const file = await user.getFileHandle('notes.txt', { create: true });
  const writable = await file.createWritable();
  await writable.write('six notes\\n');
  await writable.close();
  if (localStorage.getItem('slicc-os.six') === 'upgraded') {
    six.dataset.moved = 'yes';
    return;
  }
  await navigator.serviceWorker.register('/preview-sw.js', { scope: '/preview/' });
  await navigator.serviceWorker.getRegistration('/preview/').then((registration) =>
    registration.active ? null : new Promise((done) => {
      const worker = registration.installing ?? registration.waiting;
      worker.addEventListener('statechange', () => worker.state === 'activated' && done());
    })
  );
  const channel = new BroadcastChannel('${SIX_TYPE}');
  navigator.locks.request('slicc-six-kernel', { mode: 'shared' }, () =>
    new Promise((release) => {
      six.dataset.ran = 'yes';
      channel.onmessage = ({ data }) => {
        if (data?.type !== 'stop') return;
        six.dataset.moved = 'yes';
        six.textContent = 'SLICC moved to seven in this browser';
        release();
      };
    })
  );
})();
</script>
`;

export const previewWorker = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname.startsWith('/preview/')) {
    event.respondWith(new Response('six preview', { headers: { 'content-type': 'text/plain' } }));
  }
});
`;

export const exporterPage = `<!doctype html>
<meta charset="utf-8">
<meta name="${SIX_TYPE}" content="1">
<title>SLICC 6 to seven</title>
<script type="module" src="/assets/upgrade-to-seven-f1x7.js"></script>
`;

export function exporterScript(mode, foreign) {
  return `const mode = ${JSON.stringify(mode)};
const type = ${JSON.stringify(SIX_TYPE)};
const post = (message) => parent.postMessage(message, location.origin);
const ancestors = [...location.ancestorOrigins];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function walk(dir, at, out) {
  for await (const [name, handle] of dir.entries()) {
    const path = at + '/' + name;
    if (handle.kind === 'directory') await walk(handle, path, out);
    else if (path !== '/.metadata.json') out.push({ path, handle });
  }
  return out;
}

async function run() {
  post({ type, phase: 'stopping', done: 0, total: 1 });
  if (mode === 'error') {
    await pause(300);
    post({ type, error: ${JSON.stringify(STOP_ERROR)} });
    return;
  }
  if (mode === 'spoof') {
    let heard = 0;
    const both = new Promise((done) =>
      addEventListener('message', ({ data }) => data === 'spoofed' && ++heard === 2 && done())
    );
    const same = document.createElement('iframe');
    same.srcdoc = ${JSON.stringify(`<script>parent.parent.postMessage({ type: '${SIX_TYPE}', done: true, exportId: 'sibling', dir: '/slicc-v6-upgrade/sibling/' }, '*'); parent.postMessage('spoofed', '*');</script>`)};
    const other = document.createElement('iframe');
    other.src = ${JSON.stringify(foreign)} + '/spoof.html';
    document.body.append(same, other);
    await both;
  }
  const channel = new BroadcastChannel(type);
  const stop = () => channel.postMessage({ type: 'stop' });
  stop();
  const asking = setInterval(stop, 2000);
  await new Promise((held) =>
    navigator.locks.request('slicc-six-kernel', { mode: 'exclusive' }, () => {
      held();
      return new Promise(() => {});
    })
  );
  clearInterval(asking);
  post({ type, phase: 'stopping', done: 1, total: 1 });
  const root = await navigator.storage.getDirectory();
  const files = await walk(await root.getDirectoryHandle('slicc-fs'), '', []);
  const rows = [];
  for (const [at, { path, handle }] of files.entries()) {
    post({ type, phase: 'reading', done: at, total: files.length });
    const bytes = await (await handle.getFile()).arrayBuffer();
    rows.push({ path: 'files' + (path.startsWith('/home/user/') ? '/home-user/' + path.slice(11) : path), size: bytes.byteLength, sha256: mode === 'tamper' ? '0'.repeat(64) : await sha256(bytes), source: '/slicc-fs' + path });
    await pause(150);
  }
  post({ type, phase: 'reading', done: files.length, total: files.length });
  const exportId = crypto.randomUUID();
  const exports = await root.getDirectoryHandle('slicc-v6-upgrade', { create: true });
  const dir = await exports.getDirectoryHandle(exportId, { create: true });
  post({ type, phase: 'writing', done: 0, total: 1 });
  if (mode === 'slow') await new Promise(() => {});
  const manifest = {
    format: 'slicc-profile',
    version: 2,
    exportId,
    producer: { slicc: '6.0.0-test', origin: location.origin },
    createdAt: new Date().toISOString(),
    licks: null,
    gitconfig: null,
    cones: [],
    frozen: [],
    skills: [],
    sprinkles: [],
    files: rows,
    skipped: [],
    flagged: [],
  };
  if (mode !== 'lost') {
    const writable = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable();
    await writable.write(JSON.stringify(manifest));
    await writable.close();
  }
  post({ type, phase: 'writing', done: 1, total: 1 });
  post({ type, done: true, exportId, dir: '/slicc-v6-upgrade/' + exportId + '/' });
}

if (ancestors.length && ancestors.every((origin) => origin === location.origin)) {
  run().catch((error) => post({ type, error: error.message }));
}
`;
}

export const spoofPage = `<!doctype html>
<script>
parent.parent.postMessage({ type: '${SIX_TYPE}', done: true, exportId: 'foreign', dir: '/slicc-v6-upgrade/foreign/' }, '*');
parent.postMessage('spoofed', '*');
</script>
`;

export async function startWww(seven) {
  const state = { mode: 'ok', isolate: false, asked: [] };
  let foreign = '';
  const www = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://www');
    state.asked.push(url.pathname);
    if (url.pathname === '/7') return response.writeHead(301, { location: '/7/' }).end();
    if (url.pathname.startsWith('/7/') || url.pathname.startsWith('/fonts/')) {
      const path = url.pathname.startsWith('/7/') ? url.pathname.slice(2) : url.pathname;
      const upstream = await fetch(new URL(`${path}${url.search}`, seven));
      const headers = Object.fromEntries(
        [...upstream.headers].filter(
          ([name]) => !['content-encoding', 'transfer-encoding'].includes(name)
        )
      );
      if (url.pathname === '/7/sw.js') headers['service-worker-allowed'] = '/';
      if (state.isolate && headers['content-type']?.startsWith('text/html')) {
        headers['cross-origin-opener-policy'] = 'same-origin';
        headers['cross-origin-embedder-policy'] = 'require-corp';
      }
      return response
        .writeHead(upstream.status, headers)
        .end(Buffer.from(await upstream.arrayBuffer()));
    }
    if (url.pathname.startsWith('/os/')) {
      return request.headers['sec-fetch-mode'] === 'navigate'
        ? response.writeHead(302, { location: '/7/' }).end()
        : response.writeHead(404).end();
    }
    const html = { 'content-type': 'text/html; charset=utf-8' };
    const js = { 'content-type': 'text/javascript; charset=utf-8' };
    const corp = {
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
    };
    const framed = {
      ...corp,
      'content-security-policy': "frame-ancestors 'self'",
      'x-frame-options': 'SAMEORIGIN',
      'cache-control': 'no-store',
    };
    if (url.pathname === '/') return response.writeHead(200, html).end(sixPage);
    if (url.pathname === '/preview-sw.js') return response.writeHead(200, js).end(previewWorker);
    if (url.pathname === '/spoof.html') {
      return response
        .writeHead(200, {
          ...html,
          'cross-origin-embedder-policy': 'require-corp',
          'cross-origin-resource-policy': 'cross-origin',
        })
        .end(spoofPage);
    }
    if (url.pathname === '/upgrade-to-seven.html') {
      return response.writeHead(200, { ...html, ...framed }).end(exporterPage);
    }
    if (url.pathname === '/assets/upgrade-to-seven-f1x7.js') {
      return response
        .writeHead(200, { ...js, ...corp, 'cache-control': 'no-store' })
        .end(exporterScript(state.mode, foreign));
    }
    response.writeHead(404).end();
  });
  await new Promise((done) => www.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${www.address().port}`;
  foreign = `http://localhost:${www.address().port}`;
  return {
    state,
    origin,
    close: () =>
      new Promise((done) => {
        www.close(done);
        www.closeAllConnections();
      }),
  };
}
