import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';
import { debuggerUrl, launch } from './chrome.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: chosen } = server.address();
    server.close(() => resolve(chosen));
  });
});

const pages = {
  '/register': `<!doctype html><title>register</title><script>
    navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { document.title = 'sw-ready'; })
      .catch((error) => { document.title = 'sw-fail ' + error.message; });
    try { new SharedWorker('/shared.js'); }
    catch (error) { document.title = 'shared-fail ' + error.message; }
  </script>`,
  '/sw.js':
    "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));",
  '/shared.js': 'onconnect = () => {};',
  '/page': '<!doctype html><title>page</title><p>page</p>',
  '/next': '<!doctype html><title>next</title><p>next</p>',
};

const stand = createHttp((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const body = pages[url.pathname];
  if (!body) return res.writeHead(404).end('missing');
  const type = url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
const standPort = stand.address().port;
const origin = (host) => `http://${host}:${standPort}`;
const ORDINARY = origin('ordinary.test');
const VAULT = origin('vault.sliccy.ai');
const SEVEN = origin('seven.sliccy.ai');

const chrome = await launch({
  args: [
    `--remote-debugging-port=${port}`,
    '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1, MAP ordinary.test 127.0.0.1, MAP seven.sliccy.ai 127.0.0.1',
    `--unsafely-treat-insecure-origin-as-secure=${ORDINARY},${VAULT},${SEVEN}`,
  ],
});
const browser = await debuggerUrl(port);
after(() => {
  chrome.close();
  stand.close();
});

function socketClient(onMessage) {
  const socket = new WebSocket(browser);
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  ready.catch(() => {});
  socket.onmessage = ({ data }) => onMessage(String(data));
  return {
    ready,
    send(text) {
      socket.send(text);
    },
    close() {
      socket.close();
    },
  };
}

function rawCdp() {
  const pending = new Map();
  let next = 0;
  const socket = socketClient((text) => {
    const message = JSON.parse(text);
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  const send = async (method, params = {}, sessionId) => {
    await socket.ready;
    next += 1;
    const id = next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} got no answer from Chrome` } });
      }, 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };
  return { send, close: socket.close };
}

function guardedCdp() {
  const pending = new Map();
  let next = 0;
  let incoming = null;
  const socket = socketClient((text) => incoming?.(text));
  const connection = {
    set onmessage(fn) {
      incoming = fn;
    },
    get onmessage() {
      return incoming;
    },
    send(text) {
      socket.send(text);
    },
    close() {
      socket.close();
    },
  };
  const guarded = guardProtected(connection, SEVEN);
  guarded.onmessage = (text) => {
    const message = JSON.parse(text);
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  };
  const send = async (method, params = {}, sessionId, ms = 15000) => {
    await socket.ready;
    next += 1;
    const id = next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} got no answer` } });
      }, ms);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      guarded.send(JSON.stringify(payload));
    });
  };
  return { send, close: socket.close };
}

const raw = rawCdp();
const guard = guardedCdp();
after(() => {
  raw.close();
  guard.close();
});

async function open(url) {
  const created = await raw.send('Target.createTarget', { url });
  if (!created.result?.targetId) throw new Error(`no target for ${url}: ${created.error?.message}`);
  return created.result.targetId;
}

async function worker(type, host) {
  const end = Date.now() + 15000;
  let saw = [];
  while (Date.now() < end) {
    const listed = await raw.send('Target.getTargets');
    saw = listed.result?.targetInfos ?? [];
    const found = saw.find((info) => info.type === type && (info.url ?? '').includes(host));
    if (found) return found;
    await pause(100);
  }
  throw new Error(
    `no ${type} on ${host}; saw ${saw.map((info) => `${info.type} ${info.url}`).join(', ')}`
  );
}

async function attach(targetId) {
  return guard.send('Target.attachToTarget', { targetId, flatten: true });
}

test('a slow frame tree on an ordinary page still reads', { timeout: 60000 }, async () => {
  const targetId = await open(`${ORDINARY}/page`);
  const attached = await attach(targetId);
  assert.equal(attached.error, undefined, JSON.stringify(attached.error));
  const sessionId = attached.result.sessionId;
  const started = await guard.send(
    'Runtime.evaluate',
    {
      expression:
        'setTimeout(() => { const end = Date.now() + 1500; while (Date.now() < end); }, 50)',
      returnByValue: true,
    },
    sessionId
  );
  assert.equal(started.error, undefined, JSON.stringify(started.error));
  await pause(200);
  const began = Date.now();
  const read = await guard.send(
    'Runtime.evaluate',
    { expression: '3+3', returnByValue: true },
    sessionId,
    10000
  );
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  assert.equal(read.result?.result?.value, 6);
  assert.ok(Date.now() - began < 8000);
});

test('a remembered world is not reused after Runtime.disable and a navigation', {
  timeout: 60000,
}, async () => {
  const targetId = await open(`${ORDINARY}/page`);
  const attached = await attach(targetId);
  assert.equal(attached.error, undefined, JSON.stringify(attached.error));
  const sessionId = attached.result.sessionId;
  assert.equal((await guard.send('Page.enable', {}, sessionId)).error, undefined);
  assert.equal((await guard.send('Runtime.enable', {}, sessionId)).error, undefined);
  const before = await guard.send(
    'Runtime.evaluate',
    { expression: 'location.pathname', returnByValue: true },
    sessionId
  );
  assert.equal(before.result?.result?.value, '/page');
  assert.equal((await guard.send('Runtime.disable', {}, sessionId)).error, undefined);
  const moved = await guard.send('Page.navigate', { url: `${ORDINARY}/next` }, sessionId);
  assert.equal(moved.error, undefined, JSON.stringify(moved.error));
  let last;
  for (const end = Date.now() + 8000; Date.now() < end; ) {
    last = await guard.send(
      'Runtime.evaluate',
      { expression: 'location.pathname', returnByValue: true },
      sessionId
    );
    if (last.error?.message?.includes('Cannot find context')) break;
    if (last.result?.result?.value === '/next') break;
    await pause(100);
  }
  if (last.error) {
    const info = await raw.send('Target.getTargetInfo', { targetId });
    assert.equal(
      last.error,
      undefined,
      `${JSON.stringify(last.error)} url=${info.result?.targetInfo?.url ?? ''}`
    );
  }
  assert.equal(last.result?.result?.value, '/next');
});

test('an ordinary service worker is answered and a seven or vault worker is refused', {
  timeout: 60000,
}, async () => {
  await open(`${ORDINARY}/register`);
  await open(`${VAULT}/register`);
  await open(`${SEVEN}/register`);
  const ordinary = await worker('service_worker', 'ordinary.test');
  const vault = await worker('service_worker', 'vault.sliccy.ai');
  const seven = await worker('service_worker', 'seven.sliccy.ai');
  const shared = await worker('shared_worker', 'ordinary.test');
  const allowed = await attach(ordinary.targetId);
  assert.equal(allowed.error, undefined, JSON.stringify(allowed.error));
  const read = await guard.send(
    'Runtime.evaluate',
    { expression: '1+1', returnByValue: true },
    allowed.result.sessionId
  );
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  assert.equal(read.result?.result?.value, 2);
  const sharedRead = await attach(shared.targetId);
  assert.equal(sharedRead.error, undefined, JSON.stringify(sharedRead.error));
  const sharedValue = await guard.send(
    'Runtime.evaluate',
    { expression: '1+1', returnByValue: true },
    sharedRead.result.sessionId
  );
  assert.equal(sharedValue.result?.result?.value, 2);
  for (const targetId of [vault.targetId, seven.targetId]) {
    const refused = await attach(targetId);
    assert.equal(refused.error?.message, PROTECTED, JSON.stringify(refused));
  }
});
