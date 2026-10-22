import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { executablePath } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/browser.mjs';
import { guardProtected, SCRIPTS } from '../../src/seed/guard.js';
import { cdpConnection } from '../../src/seed/link.js';
import { boot } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';

const KINDS = [
  'navigation',
  'history-back',
  'history-forward',
  'pushState',
  'bfcache',
  'iframe-same-site',
  'iframe-cross-site',
  'error-page',
];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: chosen } = server.address();
    server.close(() => resolve(chosen));
  });
});

const html = (body, headers = {}) => ({
  headers: { 'content-type': 'text/html', ...headers },
  body: `<!doctype html><html><head><title>STAND</title></head><body>${body}</body></html>`,
});

const stand = createHttp((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/fresh') {
    res.writeHead(200, html('', { 'cache-control': 'no-store' }).headers);
    return res.end(
      html(`<h1>${url.searchParams.get('n')}</h1>`, { 'cache-control': 'no-store' }).body
    );
  }
  if (url.pathname === '/keep') {
    const go = url.searchParams.get('go');
    const back = url.searchParams.get('back');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      html(
        `<h1>${url.searchParams.get('n')}</h1><script>addEventListener('pageshow', (event) => { if (event.persisted) document.documentElement.dataset.bf = '1'; });${go ? `setTimeout(() => { location.href = ${JSON.stringify(go)}; }, 400);` : ''}${back ? 'setTimeout(() => history.back(), 1000);' : ''}</script>`
      ).body
    );
  }
  if (url.pathname === '/frame') {
    res.writeHead(200, html('<h1>FRAME</h1>', { 'origin-agent-cluster': '?1' }).headers);
    return res.end(html('<h1>FRAME</h1>', { 'origin-agent-cluster': '?1' }).body);
  }
  if (url.pathname === '/csp') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><title>CSP</title></head><body><script>document.documentElement.dataset.k='inline'</script></body></html>`
    );
  }
  if (url.pathname === '/doc' || url.pathname === '/parent') {
    const page = html('<h1>STAND-BODY</h1>');
    res.writeHead(200, page.headers);
    return res.end(page.body);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('missing');
});
await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
const standPort = stand.address().port;
const PLAIN = `http://localhost:${standPort}`;
const SITE = `http://plain.test:${standPort}`;
const CHILD = `http://child.plain.test:${standPort}`;

const dead = createServer((socket) => socket.destroy());
await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
const deadPort = dead.address().port;

const profile = await mkdtemp(join(tmpdir(), 'guard-later-'));
const driven = spawn(
  await executablePath(),
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--isolate-origins=http://child.plain.test:${standPort}`,
    '--host-resolver-rules=MAP plain.test 127.0.0.1, MAP child.plain.test 127.0.0.1',
  ],
  { stdio: 'ignore' }
);
const chrome = await launch();
const origin = new URL(chrome.url).origin;
after(() => {
  driven.kill('SIGKILL');
  chrome.close();
  stand.close();
  dead.close();
  return rm(profile, { recursive: true, force: true });
});
const browser = await debuggerUrl(port);

function socketClient() {
  const socket = new WebSocket(browser);
  const pending = new Map();
  const waiters = [];
  let next = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    for (const waiter of waiters) waiter(message);
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  ready.catch(() => {});
  const send = async (method, params = {}, sessionId, ms = 15000) => {
    await ready;
    next += 1;
    const id = next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} got no answer from Chrome` } });
      }, ms);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };
  return {
    send,
    close: () => socket.close(),
    listen: (fn) => waiters.push(fn),
    raw: socket,
    opened: ready,
  };
}

const own = socketClient();
after(() => own.close());

async function urlOf(targetId) {
  const { result } = await own.send('Target.getTargetInfo', { targetId });
  return result?.targetInfo?.url ?? '';
}

const named = (href, nonce, which) => {
  try {
    return new URL(href).searchParams.get('n') === `${which}-${nonce}`;
  } catch {
    return false;
  }
};

async function until(label, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await ready();
    if (last) return last;
    await pause(100);
  }
  assert.fail(`${label} did not settle (last ${JSON.stringify(last)})`);
}

async function tab(url) {
  const { result } = await own.send('Target.createTarget', { url });
  const targetId = result?.targetId;
  assert.ok(targetId, JSON.stringify(result));
  await until(url, async () => {
    const href = await urlOf(targetId);
    return href.startsWith(url.split('?')[0]) && !href.endsWith('about:blank') ? href : null;
  });
  return targetId;
}

async function closeTargets(ids) {
  for (const targetId of ids) await own.send('Target.closeTarget', { targetId });
}

function guardClient(send, saw = null) {
  return {
    saw,
    async send(method, params = {}, sessionId) {
      return send(method, params, sessionId ?? null);
    },
    async attach(targetId) {
      const answer = await send('Target.attachToTarget', { targetId, flatten: true }, null);
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      const sessionId = answer.result.sessionId;
      assert.equal((await send('Page.enable', {}, sessionId)).error, undefined, 'Page.enable');
      assert.equal(
        (await send('Runtime.enable', {}, sessionId)).error,
        undefined,
        'Runtime.enable'
      );
      return sessionId;
    },
  };
}

function linkStream(socket, saw) {
  const incoming = [];
  let reader = null;
  const push = (bytes) => {
    if (reader) {
      const resolve = reader;
      reader = null;
      resolve(bytes);
      return;
    }
    incoming.push(bytes);
  };
  let pending = new Uint8Array(0);
  const take = () => {
    if (pending.length < 4) return null;
    const length = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(
      0
    );
    if (pending.length < 4 + length) return null;
    const text = new TextDecoder().decode(pending.subarray(4, 4 + length));
    pending = pending.slice(4 + length);
    return text;
  };
  socket.onmessage = ({ data }) => {
    const body = new TextEncoder().encode(String(data));
    const framed = new Uint8Array(4 + body.length);
    new DataView(framed.buffer).setUint32(0, body.length);
    framed.set(body, 4);
    push(framed);
  };
  return {
    read: () => {
      if (incoming.length) return Promise.resolve(incoming.shift());
      return new Promise((resolve) => {
        reader = resolve;
      });
    },
    write(framed) {
      const merged = new Uint8Array(pending.length + framed.length);
      merged.set(pending);
      merged.set(framed, pending.length);
      pending = merged;
      for (;;) {
        const text = take();
        if (text === null) break;
        const message = JSON.parse(text);
        if (message.method) saw.push({ method: message.method, params: message.params ?? {} });
        socket.send(text);
      }
    },
    close: () => socket.close(),
    closeWrite() {},
  };
}

function nodeGuard(connection, saw) {
  const guarded = guardProtected(connection, origin);
  const pending = new Map();
  let next = 0;
  guarded.onmessage = (text) => {
    const message = JSON.parse(text);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} got no answer` } });
      }, 20000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      guarded.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return guardClient(send, saw);
}

const seven = await chrome.page(test);
const extensionSocket = socketClient();
const extensionSaw = [];
await seven.expose('cdpOut', (command) => {
  const message = typeof command === 'string' ? JSON.parse(command) : command;
  if (message.method) extensionSaw.push({ method: message.method, params: message.params ?? {} });
  if (extensionSocket.raw.readyState === 1) extensionSocket.raw.send(JSON.stringify(message));
});
extensionSocket.listen((message) => {
  void seven.evaluate((text) => window.cdpIn(text), JSON.stringify(message)).catch(() => false);
});
await seven.init(() => {
  const pending = new Map();
  const listeners = new Set();
  let next = 0;
  window.cdpIn = (text) => {
    const message = JSON.parse(text);
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    if (message.method) for (const listener of listeners) listener(message);
  };
  Object.defineProperty(globalThis, 'sliccExtension', {
    value: Object.freeze({
      fetch: (input, init) => fetch(input, init),
      cdp: Object.freeze({
        send(method, params, sessionId) {
          const id = ++next;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            window.cdpOut(JSON.stringify({ id, method, params, sessionId }));
          });
        },
        on(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
    }),
  });
});
await boot(seven);
await extensionSocket.opened;

const proxy = await startProxy({
  port: 0,
  origins: [origin],
  cdp: `http://127.0.0.1:${port}`,
  kernelPort: null,
  log: () => {},
});
after(() => proxy.close());

await seven.evaluate(
  async (proxyArg) => {
    const { guardProtected: protect } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection, proxyHost } = await import(new URL('cdp.js', location.href).href);
    const arm = (connection) => {
      const pending = new Map();
      let next = 0;
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        if (message.id === undefined) return;
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      };
      return (method, params = {}, sessionId = undefined) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer` } });
          }, 20000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        });
    };
    window.extensionSend = arm(
      protect(extensionConnection(globalThis.sliccExtension.cdp), location.origin)
    );
    window.proxySend = arm(protect(await proxyHost(proxyArg)(), location.origin));
  },
  { url: proxy.url, key: proxy.key }
);

const pageSend = (name) => (method, params, sessionId) =>
  seven.evaluate(
    ([which, called, args, session]) => window[which](called, args ?? {}, session ?? undefined),
    [name, method, params ?? {}, sessionId]
  );

const extension = guardClient(pageSend('extensionSend'), extensionSaw);
const proxyGuard = guardClient(pageSend('proxySend'));
const linkSocket = socketClient();
await linkSocket.opened;
const linkSaw = [];
const link = nodeGuard(cdpConnection(linkStream(linkSocket.raw, linkSaw)), linkSaw);
after(() => {
  extensionSocket.close();
  linkSocket.close();
});

async function navigate(guard, url, sessionId) {
  const answer = await guard.send('Page.navigate', { url }, sessionId);
  assert.equal(answer.error, undefined, JSON.stringify(answer));
}

async function at(guard, kind, nonce) {
  if (kind === 'navigation') {
    const targetId = await tab(`${PLAIN}/doc?start-${nonce}`);
    const sessionId = await guard.attach(targetId);
    const next = `${PLAIN}/doc?navigated-${nonce}`;
    await navigate(guard, next, sessionId);
    await until(next, async () =>
      (await urlOf(targetId)).includes(`navigated-${nonce}`) ? true : null
    );
    return { targetId, sessionId, extra: [] };
  }
  if (kind === 'history-back' || kind === 'history-forward') {
    const targetId = await tab(`${PLAIN}/fresh?n=a-${nonce}`);
    const sessionId = await guard.attach(targetId);
    await navigate(guard, `${PLAIN}/fresh?n=b-${nonce}`, sessionId);
    await until('history b', async () =>
      (await urlOf(targetId)).includes(`b-${nonce}`) ? true : null
    );
    const back = await guard.send(
      'Runtime.evaluate',
      { expression: 'history.back()', userGesture: true },
      sessionId
    );
    assert.equal(back.error, undefined, JSON.stringify(back));
    await until('history a', async () =>
      (await urlOf(targetId)).includes(`a-${nonce}`) ? true : null
    );
    if (kind === 'history-back') return { targetId, sessionId, extra: [] };
    const forward = await guard.send(
      'Runtime.evaluate',
      { expression: 'history.forward()', userGesture: true },
      sessionId
    );
    assert.equal(forward.error, undefined, JSON.stringify(forward));
    await until('history forward', async () =>
      (await urlOf(targetId)).includes(`b-${nonce}`) ? true : null
    );
    return { targetId, sessionId, extra: [] };
  }
  if (kind === 'pushState') {
    const targetId = await tab(`${PLAIN}/doc?push-${nonce}`);
    const sessionId = await guard.attach(targetId);
    const pushed = await guard.send(
      'Runtime.evaluate',
      {
        expression: `history.pushState({ n: 1 }, '', ${JSON.stringify(`/doc?pushed-${nonce}`)})`,
        userGesture: true,
      },
      sessionId
    );
    assert.equal(pushed.error, undefined, JSON.stringify(pushed));
    await until('pushState', async () =>
      (await urlOf(targetId)).includes(`pushed-${nonce}`) ? true : null
    );
    return { targetId, sessionId, extra: [] };
  }
  if (kind === 'bfcache') {
    const back = `${PLAIN}/keep?n=b-${nonce}&back=1`;
    const opened = await own.send('Target.createTarget', {
      url: `${PLAIN}/keep?n=a-${nonce}&go=${encodeURIComponent(back)}`,
    });
    const targetId = opened.result?.targetId;
    assert.ok(targetId, JSON.stringify(opened));
    await until('bfcache away', async () =>
      named(await urlOf(targetId), nonce, 'b') ? true : null
    );
    await until(
      'bfcache return',
      async () => (named(await urlOf(targetId), nonce, 'a') ? true : null),
      15000
    );
    const sessionId = await guard.attach(targetId);
    const restored = await guard.send(
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify({ bf: document.documentElement.dataset.bf ?? null, type: performance.getEntriesByType("navigation")[0]?.type ?? null, why: performance.getEntriesByType("navigation")[0]?.notRestoredReasons ?? null })',
        returnByValue: true,
      },
      sessionId
    );
    const info = JSON.parse(restored.result?.result?.value ?? 'null');
    assert.equal(info?.bf, '1', JSON.stringify(restored));
    return { targetId, sessionId, extra: [] };
  }
  if (kind === 'iframe-same-site' || kind === 'iframe-cross-site') {
    const parent =
      kind === 'iframe-same-site' ? `${SITE}/parent?n=${nonce}` : `${PLAIN}/parent?n=${nonce}`;
    const child =
      kind === 'iframe-same-site' ? `${CHILD}/frame?n=${nonce}` : `${SITE}/frame?n=${nonce}`;
    const targetId = await tab(parent);
    const sessionId = await guard.attach(targetId);
    const opened = await guard.send(
      'Runtime.evaluate',
      {
        expression: `document.body.append(Object.assign(document.createElement('iframe'), { src: ${JSON.stringify(child)} })); 1`,
        userGesture: true,
      },
      sessionId
    );
    assert.equal(opened.error, undefined, JSON.stringify(opened));
    const found = await until(
      `${kind} target`,
      async () => {
        const { result } = await own.send('Target.getTargets');
        const infos = result?.targetInfos ?? [];
        return (
          infos.find(
            (info) => info.targetId !== targetId && info.url.includes(`frame?n=${nonce}`)
          ) ?? null
        );
      },
      10000
    );
    const childSession = await guard.attach(found.targetId);
    return { targetId: found.targetId, sessionId: childSession, extra: [targetId] };
  }
  const targetId = await tab(`${PLAIN}/doc?before-${nonce}`);
  const raw = (await own.send('Target.attachToTarget', { targetId, flatten: true })).result
    ?.sessionId;
  assert.ok(raw, 'error page raw session');
  await own.send('Runtime.enable', {}, raw);
  await own.send('Page.navigate', { url: `http://127.0.0.1:${deadPort}/down-${nonce}` }, raw);
  let href = '';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const answer = await own.send(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
      raw
    );
    href = answer.result?.result?.value ?? '';
    if (href.startsWith('chrome-error://')) break;
    await pause(100);
  }
  await own.send('Target.detachFromTarget', { sessionId: raw });
  assert.ok(href.startsWith('chrome-error://'), `error page, saw ${href}`);
  const sessionId = await guard.attach(targetId);
  return { targetId, sessionId, extra: [] };
}

async function probe(targetId, token, binding, follow = true) {
  const attached = await own.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  assert.ok(sessionId, JSON.stringify(attached));
  await own.send('Page.enable', {}, sessionId);
  await own.send('Runtime.enable', {}, sessionId);
  const bound = await own.send(
    'Runtime.evaluate',
    {
      expression: `typeof globalThis[${JSON.stringify(binding)}]`,
      returnByValue: true,
    },
    sessionId
  );
  assert.equal(bound.result?.result?.value, 'undefined', JSON.stringify(bound));
  if (!follow) {
    await own.send('Target.detachFromTarget', { sessionId });
    return { later: null, k: null, binding: 'undefined' };
  }
  await own.send(
    'Runtime.evaluate',
    {
      expression: `location.assign(${JSON.stringify(`${PLAIN}/csp?n=${token}`)})`,
      userGesture: true,
    },
    sessionId
  );
  let note = '';
  let reading = null;
  for (const deadline = Date.now() + 15000; Date.now() < deadline && !reading; ) {
    const href = await own.send(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
      sessionId
    );
    const here = href.result?.result?.value ?? '';
    if (here.includes(`/csp?n=${token}`)) reading = sessionId;
    else {
      const { result } = await own.send('Target.getTargets');
      const infos = result?.targetInfos ?? [];
      note = `${here} [${infos.map((info) => info.url).join(' ')}]`;
      const found = infos.find((info) => info.url?.includes(`/csp?n=${token}`));
      if (found) {
        const next = await own.send('Target.attachToTarget', {
          targetId: found.targetId,
          flatten: true,
        });
        reading = next.result?.sessionId ?? null;
        if (reading) await own.send('Runtime.enable', {}, reading);
      }
    }
    if (!reading) await pause(100);
  }
  assert.ok(reading, `csp did not settle (${note})`);
  const read = await own.send(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify({ later: document.documentElement?.dataset.later ?? null, k: document.documentElement?.dataset.k ?? null, binding: typeof globalThis[${JSON.stringify(binding)}] })`,
      returnByValue: true,
    },
    reading
  );
  await own.send('Target.detachFromTarget', { sessionId });
  if (reading !== sessionId) await own.send('Target.detachFromTarget', { sessionId: reading });
  assert.equal(read.error, undefined, JSON.stringify(read));
  return JSON.parse(read.result.result.value);
}

test('scripts and bindings for later documents stay refused after each commit', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const paths = [
    ['extension', extension],
    ['link', link],
    ['proxy', proxyGuard],
  ];
  let n = 0;
  for (const [transport, guard] of paths) {
    await t.test(transport, async (t) => {
      for (const kind of KINDS) {
        await t.test(kind, async () => {
          n += 1;
          const token = `${transport}${kind.replaceAll('-', '')}${n}`;
          const binding = `later${token}`;
          const opened = [];
          try {
            const placed = await at(guard, kind, token);
            opened.push(placed.targetId, ...placed.extra);
            if (kind !== 'error-page') {
              const live = await guard.send(
                'Runtime.evaluate',
                { expression: '1+1', returnByValue: true },
                placed.sessionId
              );
              assert.equal(live.result?.result?.value, 2, JSON.stringify(live));
            }
            const commands = [
              [
                'Page.addScriptToEvaluateOnNewDocument',
                { source: `document.documentElement.dataset.later=${JSON.stringify(token)}` },
              ],
              ['Runtime.addBinding', { name: binding }],
              ['Page.setBypassCSP', { enabled: true }],
            ];
            for (const [method, params] of commands) {
              const mark = guard.saw?.length ?? 0;
              const answer = await guard.send(method, params, placed.sessionId);
              const label = `${transport} ${kind} ${method}`;
              assert.equal(
                answer.result,
                undefined,
                `PASSED-THROUGH ${label} ${JSON.stringify(answer)}`
              );
              assert.equal(answer.error?.message, SCRIPTS, `${label} ${JSON.stringify(answer)}`);
              if (guard.saw) {
                const forwarded = guard.saw.slice(mark).some((item) => item.method === method);
                assert.equal(forwarded, false, `PASSED-THROUGH ${label} on the wire`);
              }
            }
            const effect = await probe(placed.targetId, token, binding, !kind.startsWith('iframe'));
            assert.deepEqual(
              effect,
              { later: null, k: null, binding: 'undefined' },
              `PASSED-THROUGH ${transport} ${kind} ${JSON.stringify(effect)}`
            );
          } finally {
            await closeTargets(opened);
          }
        });
      }
    });
  }
});
