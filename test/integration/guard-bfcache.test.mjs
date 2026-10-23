import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { guardProtected } from '../../src/seed/guard.js';
import { cdpConnection } from '../../src/seed/link.js';
import { boot } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';

const RUNS = Number(process.env.BF_RUNS ?? 8);
const READ_LAG = 2500;
const CASES = [
  ['seven', 'back'],
  ['seven', 'forward'],
  ['vault', 'back'],
  ['vault', 'forward'],
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const burners = [];
for (let core = 0; core < 4; core += 1) {
  burners.push(
    spawn(
      process.execPath,
      [
        '-e',
        'const end=Date.now()+300000;while(Date.now()<end){let x=0;for(let i=0;i<1e6;i+=1)x+=i;globalThis.__x=x}',
      ],
      { stdio: 'ignore' }
    )
  );
}

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: chosen } = server.address();
    server.close(() => resolve(chosen));
  });
});

const beacons = [];
const heard = [];
const html =
  '<!doctype html><html><head><title>STAND</title></head><body><h1>STAND-BODY</h1></body></html>';
const stand = createHttp((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  heard.push({ host: url.host, path: url.pathname });
  if (url.pathname === '/beacon') {
    beacons.push({ id: url.searchParams.get('id'), host: url.searchParams.get('host') });
    res.writeHead(204, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    return res.end();
  }
  if (url.pathname === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(html);
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('missing');
});
await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
const standPort = stand.address().port;
const ORDINARY = `http://ordinary.test:${standPort}`;
const VAULT = `http://vault.sliccy.ai:${standPort}`;

const chrome = await launch({
  args: [
    `--remote-debugging-port=${port}`,
    '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1, MAP ordinary.test 127.0.0.1',
  ],
});
const SEVEN = new URL(chrome.url).origin;
chrome.overrides.set('/probe-bf.html', html);
after(() => {
  for (const burner of burners) burner.kill('SIGKILL');
  chrome.close();
  stand.close();
});
const browser = await debuggerUrl(port);

function cdp() {
  const socket = new WebSocket(browser);
  const pending = new Map();
  const events = [];
  let next = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else events.push(message);
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  ready.catch(() => {});
  const send = async (method, params = {}, sessionId) => {
    await ready;
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
  return { send, events, close: () => socket.close() };
}

const own = cdp();
after(() => own.close());

async function waitUrl(targetId, url, ms = 8000) {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    last = (await own.send('Target.getTargetInfo', { targetId })).result?.targetInfo?.url ?? '';
    if (last.split('#')[0] === url) return last;
    await pause(20);
  }
  throw new Error(`tab stayed on ${last}, wanted ${url}`);
}

async function committed(sessionId, url) {
  const end = Date.now() + 8000;
  let index = 0;
  let count = 0;
  while (Date.now() < end) {
    const history = await own.send('Page.getNavigationHistory', {}, sessionId);
    const entries = history.result?.entries ?? [];
    index = history.result?.currentIndex ?? 0;
    count = entries.length;
    const current = entries[index]?.url ?? '';
    if (entries.length > index && current.split('#')[0] === url) return;
    await pause(20);
  }
  throw new Error(`document was not committed index=${index} entries=${count}`);
}

async function seed(targetId, sessionId, url) {
  const answer = await own.send('Page.navigate', { url }, sessionId);
  if (answer.error) throw new Error(`${url}: ${answer.error.message}`);
  await waitUrl(targetId, url);
  const marked = await own.send(
    'Runtime.evaluate',
    { expression: 'window.__bf = "live"', returnByValue: true },
    sessionId
  );
  if (marked.error) throw new Error(marked.error.message);
}

async function historyTo(targetId, sessionId, expression, url) {
  const from = heard.length;
  const pages = chrome.requests.length;
  const end = Date.now() + 8000;
  let ready = false;
  while (Date.now() < end) {
    const history = await own.send('Page.getNavigationHistory', {}, sessionId);
    const entries = history.result?.entries ?? [];
    const index = history.result?.currentIndex ?? 0;
    const current = entries[index]?.url ?? '';
    if (entries.length > index && index > 0 && current.split('#')[0] !== url) {
      ready = true;
      break;
    }
    await pause(20);
  }
  if (!ready) throw new Error(`no earlier document before ${expression}`);
  const answer = await own.send(
    'Runtime.evaluate',
    { expression, userGesture: true, returnByValue: true },
    sessionId
  );
  if (answer.error) throw new Error(answer.error.message);
  await waitUrl(targetId, url);
  return { heard: heard.length - from, pages: chrome.requests.length - pages };
}

async function guardPage(t, proxy = null) {
  const seven = await chrome.page(t);
  chrome.overrides.set('/probe-bf.html', html);
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  t.after(() => socket.close());
  socket.onmessage = ({ data }) => {
    void seven.evaluate((message) => window.cdpIn(message), data).catch(() => false);
  };
  let holding = false;
  let sawHold = false;
  const parked = [];
  let captured = null;
  const noteHold = () => {
    sawHold = true;
    captured?.();
    captured = null;
  };
  const heldCommand = (command) => {
    let message = command;
    if (typeof command === 'string') {
      try {
        message = JSON.parse(command);
      } catch {
        return false;
      }
    }
    return (
      holding &&
      message?.method === 'Runtime.evaluate' &&
      String(message.params?.expression ?? '').includes('BFHOLD')
    );
  };
  await seven.expose('holdSeen', () => {
    noteHold();
  });
  await seven.expose('cdpOut', (command) => {
    if (heldCommand(command)) {
      parked.push(command);
      noteHold();
      return;
    }
    if (socket.readyState === 1) socket.send(JSON.stringify(command));
  });
  await seven.init(() => {
    const pending = new Map();
    const listeners = new Set();
    let next = 0;
    const socketSend = WebSocket.prototype.send;
    const parkedSockets = [];
    WebSocket.prototype.send = function (data) {
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        message = null;
      }
      if (
        window.holdReads &&
        message?.method === 'Runtime.evaluate' &&
        String(message.params?.expression ?? '').includes('BFHOLD')
      ) {
        parkedSockets.push([this, data]);
        window.holdSeen('{}');
        return;
      }
      return socketSend.call(this, data);
    };
    window.releaseProxyHeld = () => {
      window.holdReads = false;
      const queued = parkedSockets.splice(0);
      for (const [socket, data] of queued) socketSend.call(socket, data);
    };
    window.cdpIn = (text) => {
      const message = JSON.parse(text);
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
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
  await seven.evaluate(async (proxy) => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection, proxyHost } = await import(new URL('cdp.js', location.href).href);
    const raw = proxy
      ? await proxyHost(proxy)()
      : extensionConnection(globalThis.sliccExtension.cdp);
    let lag = 0;
    let handler = null;
    Object.defineProperty(raw, 'onmessage', {
      configurable: true,
      get() {
        return handler;
      },
      set(next) {
        handler = (text) => {
          let delay = false;
          if (lag) {
            try {
              const message = JSON.parse(text);
              delay = message.id === undefined && typeof message.method === 'string';
            } catch {
              delay = false;
            }
          }
          if (delay) setTimeout(() => next(text), lag);
          else next(text);
        };
        window.injectGuard = (text) => handler(text);
      },
    });
    window.readLag = (ms) => {
      lag = ms;
    };
    const connection = guardProtected(raw, location.origin);
    const pending = new Map();
    const events = [];
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
        return;
      }
      events.push(message);
    };
    window.guarded = {
      events,
      send: (method, params = {}, sessionId = undefined, wait = 8000) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer` } });
          }, wait);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        }),
    };
  }, proxy);
  const send = (method, params, sessionId, wait) =>
    seven.evaluate(
      ([method, params, sessionId, wait]) =>
        window.guarded.send(method, params ?? {}, sessionId ?? undefined, wait ?? 8000),
      [method, params ?? {}, sessionId ?? null, wait ?? 8000]
    );
  const events = () => seven.evaluate(() => window.guarded.events);
  const lag = (ms) => seven.evaluate((ms) => window.readLag(ms), ms);
  const inject = (text) => seven.evaluate((text) => window.injectGuard(text), text);
  return {
    seven,
    send,
    events,
    lag,
    inject,
    hold() {
      holding = true;
      return seven.evaluate(() => {
        window.holdReads = true;
      });
    },
    held() {
      return sawHold
        ? Promise.resolve()
        : new Promise((resolve) => {
            captured = resolve;
          });
    },
    release() {
      holding = false;
      const queued = parked.splice(0);
      for (const command of queued) {
        if (socket.readyState === 1) socket.send(JSON.stringify(command));
      }
      return seven.evaluate(() => window.releaseProxyHeld?.());
    },
  };
}

const marker = (id) =>
  `(() => { const host = location.host; const el = document.documentElement; if (el) el.setAttribute('data-bf', ${JSON.stringify(id)}); fetch(${JSON.stringify(`http://127.0.0.1:${standPort}/beacon`)} + '?id=' + encodeURIComponent(${JSON.stringify(id)}) + '&host=' + encodeURIComponent(host), { mode: 'no-cors', cache: 'no-store' }); return host; })()`;

function clipped(value) {
  const text = JSON.stringify(value) ?? '';
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function verdict(answer) {
  const message = answer?.error?.message ?? '';
  if (message.startsWith('slicc: refused:')) return 'refused';
  if (/session|detached|target closed|not found/i.test(message)) return 'refused';
  if (answer?.error) return 'error';
  return 'answered';
}

async function readRestored(targetId) {
  const attached = await own.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) return { bf: null, mark: null, href: attached.error?.message ?? '' };
  const answer = await own.send(
    'Runtime.evaluate',
    {
      expression:
        'JSON.stringify({bf:window.__bf??null,mark:document.documentElement&&document.documentElement.getAttribute("data-bf"),href:location.href})',
      returnByValue: true,
    },
    sessionId
  );
  await own.send('Target.detachFromTarget', { sessionId });
  try {
    return JSON.parse(answer.result?.result?.value ?? '{}');
  } catch {
    return { bf: null, mark: null, href: clipped(answer) };
  }
}

async function prepare(origin, direction, id, beforeLeave = '') {
  const protectedUrl = origin === 'seven' ? `${SEVEN}/probe-bf.html?${id}` : `${VAULT}/page?${id}`;
  const ordinaryUrl = `${ORDINARY}/page?${id}`;
  const first = direction === 'back' ? protectedUrl : ordinaryUrl;
  const created = await own.send('Target.createTarget', { url: first });
  const targetId = created.result?.targetId;
  if (!targetId) throw new Error(`no tab: ${clipped(created)}`);
  await waitUrl(targetId, first);
  const attached = await own.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) throw new Error(`no seed session: ${clipped(attached)}`);
  await own.send('Page.enable', {}, sessionId);
  await own.send('Runtime.enable', {}, sessionId);
  await committed(sessionId, first);
  if (direction === 'back') {
    await own.send(
      'Runtime.evaluate',
      { expression: `window.__bf = "live"; ${beforeLeave}`, returnByValue: true },
      sessionId
    );
    await own.send('Page.navigate', { url: ordinaryUrl }, sessionId);
    await waitUrl(targetId, ordinaryUrl);
  } else {
    await seed(targetId, sessionId, protectedUrl);
    await historyTo(targetId, sessionId, 'history.back()', ordinaryUrl);
  }
  const tree = await own.send('Page.getFrameTree', {}, sessionId);
  const frameId = tree.result?.frameTree?.frame?.id;
  if (!frameId) throw new Error(`no frame: ${clipped(tree)}`);
  await own.send('Target.detachFromTarget', { sessionId });
  return { targetId, frameId, protectedUrl, ordinaryUrl };
}

async function runOnce(guard, path, variant, origin, direction, n) {
  const id = `bf-${path}-${variant}-${origin}-${direction}-${n}-${Date.now()}`;
  const { targetId, frameId, protectedUrl } = await prepare(origin, direction, id);
  try {
    const attached = await guard.send('Target.attachToTarget', { targetId, flatten: true });
    assert.equal(attached.error, undefined, clipped(attached));
    const session = attached.result.sessionId;
    await guard.send('Page.enable', {}, session);
    await guard.send('Runtime.enable', {}, session);
    const control = await guard.send(
      'Runtime.evaluate',
      { expression: '1+1', returnByValue: true },
      session
    );
    assert.equal(control.result?.result?.value, 2, `ordinary evaluate: ${clipped(control)}`);
    await guard.lag(variant === 'lagging' ? READ_LAG : 0);
    const heardAt = heard.length;
    const pagesAt = chrome.requests.length;
    const expression = direction === 'back' ? 'history.back()' : 'history.forward()';
    await guard.send(
      'Runtime.evaluate',
      { expression, userGesture: true, returnByValue: true },
      session
    );
    const shown = await waitUrl(targetId, protectedUrl);
    const fetched =
      heard.slice(heardAt).some((hit) => hit.path === '/page') ||
      chrome.requests.slice(pagesAt).includes('/probe-bf.html');
    if (fetched) throw new Error(`${id}: restore requested the document again (${shown})`);
    const before = (await guard.events()).length;
    const answers = guard.burst
      ? await guard.burst(session, frameId, marker(id), `bf${n}`)
      : await guard.seven.evaluate(
          async ({ session, frameId, expression, worldName }) => {
            const send = window.guarded.send;
            const evaluate = send(
              'Runtime.evaluate',
              { expression, returnByValue: true, userGesture: true },
              session,
              8000
            );
            const document = send('DOM.getDocument', { depth: 0 }, session, 8000);
            const world = send('Page.createIsolatedWorld', { frameId, worldName }, session, 8000);
            const [evaluateA, documentA, worldA] = await Promise.all([evaluate, document, world]);
            const contextId = worldA.result?.executionContextId;
            const worldEval =
              contextId === undefined
                ? null
                : await send(
                    'Runtime.evaluate',
                    { expression, contextId, returnByValue: true },
                    session,
                    8000
                  );
            return { evaluate: evaluateA, document: documentA, world: worldA, worldEval };
          },
          { session, frameId, expression: marker(id), worldName: `bf${n}` }
        );
    await pause(100);
    const restored = await readRestored(targetId);
    const beacon = beacons.find((hit) => hit.id === id);
    const later = JSON.stringify((await guard.events()).slice(before));
    const host = new URL(protectedUrl).host;
    const leaked = (answer) => {
      const text = JSON.stringify(answer) ?? '';
      return text.includes(host) || text.includes(id);
    };
    const evalVerdict = verdict(answers.evaluate);
    const domVerdict = verdict(answers.document);
    const worldVerdict = verdict(answers.world);
    const worldRan = answers.worldEval ? verdict(answers.worldEval) : 'none';
    const markerHit = restored.mark === id || beacon?.host === host || later.includes(id);
    const gap =
      markerHit ||
      evalVerdict !== 'refused' ||
      leaked(answers.evaluate) ||
      domVerdict !== 'refused' ||
      leaked(answers.document) ||
      worldVerdict !== 'refused' ||
      leaked(answers.world) ||
      (answers.worldEval && (worldRan !== 'refused' || leaked(answers.worldEval)));
    const line = [
      'BFROW',
      path,
      variant,
      origin,
      direction,
      `run=${n}`,
      fetched ? 'network' : 'cached',
      `bf=${restored.bf ?? 'none'}`,
      `eval=${evalVerdict}`,
      `dom=${domVerdict}`,
      `world=${worldVerdict}`,
      `worldEval=${worldRan}`,
      `marker=${markerHit ? 'hit' : 'absent'}`,
      gap ? 'GAP' : 'pass',
    ].join(' ');
    console.log(line);
    if (gap) {
      throw new Error(
        `${line}\nshown=${shown}\nhref=${restored.href}\neval=${clipped(answers.evaluate)}\ndom=${clipped(answers.document)}\nworld=${clipped(answers.world)}\nworldEval=${clipped(answers.worldEval)}\nbeacon=${clipped(beacon ?? null)}`
      );
    }
  } finally {
    await guard.lag(0);
    await own.send('Target.closeTarget', { targetId });
  }
}

async function runHeld(guard, path, variant, origin) {
  const id = `bf-held-${path}-${variant}-${origin}-${Date.now()}`;
  const { targetId, protectedUrl } = await prepare(origin, 'back', id);
  const host = new URL(protectedUrl).host;
  try {
    const attached = await guard.send('Target.attachToTarget', { targetId, flatten: true });
    assert.equal(attached.error, undefined, clipped(attached));
    const session = attached.result.sessionId;
    await guard.send('Page.enable', {}, session);
    await guard.send('Runtime.enable', {}, session);
    const control = await guard.send(
      'Runtime.evaluate',
      { expression: '1+1', returnByValue: true },
      session
    );
    assert.equal(control.result?.result?.value, 2, `ordinary evaluate: ${clipped(control)}`);
    await guard.lag(variant === 'lagging' ? READ_LAG : 0);
    await guard.hold();
    const pending = guard.send(
      'Runtime.evaluate',
      { expression: '(() => "BFHOLD " + location.href)()', returnByValue: true },
      session
    );
    const forwarded = await Promise.race([
      guard.held().then(() => 'held'),
      pending.then(() => 'answered'),
      pause(8000).then(() => 'timeout'),
    ]);
    if (forwarded !== 'held') {
      throw new Error(`${id}: the read was ${forwarded} before the restore`);
    }
    await guard.send(
      'Runtime.evaluate',
      { expression: 'history.back()', userGesture: true, returnByValue: true },
      session
    );
    await waitUrl(targetId, protectedUrl);
    const restoredAt = Date.now();
    await pause(400);
    const after = Date.now() - restoredAt;
    await guard.release();
    const answer = await pending;
    const text = JSON.stringify(answer) ?? '';
    const kind = verdict(answer);
    const leaked = text.includes(host);
    const closed =
      kind === 'refused' || /no answer|session|detached|target closed|not found/i.test(text);
    const line = [
      'BFHELD',
      path,
      variant,
      origin,
      'back',
      `eval=${kind}`,
      `after=${after}`,
      leaked ? 'doc=protected' : 'closed',
      closed && !leaked ? 'pass' : 'GAP',
    ].join(' ');
    console.log(line);
    if (leaked || !closed) {
      throw new Error(`${line}\nanswer=${clipped(answer)}`);
    }
  } finally {
    await guard.release().catch(() => undefined);
    await guard.lag(0);
    await own.send('Target.closeTarget', { targetId });
  }
}

const leaveCounter =
  'window.__n = 0; window.__shownAt = 0; window.addEventListener("pageshow", (event) => { if (event.persisted) window.__shownAt = Date.now(); });';

function effectExpression(id) {
  const beacon = `http://127.0.0.1:${standPort}/beacon?id=${encodeURIComponent(id)}`;
  return `(() => { const el = document.documentElement; if (el) el.setAttribute("data-bf", ${JSON.stringify(id)}); window.__n = (window.__n || 0) + 1; fetch(${JSON.stringify(beacon)}, { mode: "no-cors", cache: "no-store" }); return "BFHOLD " + location.host; })()`;
}

async function readEffect(targetId) {
  const attached = await own.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) return { mark: null, n: null, shown: 0, href: attached.error?.message ?? '' };
  const answer = await own.send(
    'Runtime.evaluate',
    {
      expression:
        'JSON.stringify({mark:document.documentElement&&document.documentElement.getAttribute("data-bf"),n:window.__n??0,shown:window.__shownAt??0,href:location.href})',
      returnByValue: true,
    },
    sessionId
  );
  await own.send('Target.detachFromTarget', { sessionId });
  try {
    return JSON.parse(answer.result?.result?.value ?? '{}');
  } catch {
    return { mark: null, n: null, shown: 0, href: clipped(answer) };
  }
}

async function waitPageshow(targetId) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const read = await readEffect(targetId);
    if (read.shown) return Date.now();
    await pause(50);
  }
  return null;
}

async function runAbsent(guard, path, variant, origin) {
  const id = `bf-effect-${path}-${variant}-${origin}-${Date.now()}`;
  const { targetId, protectedUrl } = await prepare(origin, 'back', id, leaveCounter);
  const host = new URL(protectedUrl).host;
  try {
    const attached = await guard.send('Target.attachToTarget', { targetId, flatten: true });
    assert.equal(attached.error, undefined, clipped(attached));
    const session = attached.result.sessionId;
    await guard.send('Page.enable', {}, session);
    await guard.send('Runtime.enable', {}, session);
    const control = await guard.send(
      'Runtime.evaluate',
      { expression: '1+1', returnByValue: true },
      session
    );
    assert.equal(control.result?.result?.value, 2, `ordinary evaluate: ${clipped(control)}`);
    await guard.lag(variant === 'lagging' ? READ_LAG : 0);
    await guard.hold();
    const pending = guard.send(
      'Runtime.evaluate',
      { expression: effectExpression(id), returnByValue: true },
      session
    );
    const forwarded = await Promise.race([
      guard.held().then(() => 'held'),
      pending.then(() => 'answered'),
      pause(8000).then(() => 'timeout'),
    ]);
    if (forwarded !== 'held') {
      throw new Error(`${id}: the read was ${forwarded} before the restore`);
    }
    await guard.send(
      'Runtime.evaluate',
      { expression: 'history.back()', userGesture: true, returnByValue: true },
      session
    );
    const shownAt = await waitPageshow(targetId);
    if (!shownAt) throw new Error(`${id}: pageshow did not run on the restored page`);
    await pause(400);
    const after = Date.now() - shownAt;
    await guard.release();
    const answer = await pending;
    const page = await readEffect(targetId);
    const hits = beacons.filter((hit) => hit.id === id).length;
    const text = JSON.stringify(answer) ?? '';
    const kind = verdict(answer);
    const leaked = text.includes(host) || text.includes(id);
    const markerAbsent = page.mark !== id;
    const counter = page.n;
    const closed =
      kind === 'refused' || /no answer|session|detached|target closed|not found/i.test(text);
    const line = [
      'BFEFFECT',
      path,
      variant,
      origin,
      'back',
      `eval=${kind}`,
      `after=${after}`,
      `marker=${markerAbsent ? 'absent' : 'hit'}`,
      `counter=${counter}`,
      `beacons=${hits}`,
      markerAbsent && counter === 0 && hits === 0 && !leaked && closed && after >= 350
        ? 'pass'
        : 'GAP',
    ].join(' ');
    console.log(line);
    if (!markerAbsent || counter !== 0 || hits !== 0 || leaked || !closed || after < 350) {
      throw new Error(`${line}\nanswer=${clipped(answer)}\npage=${clipped(page)}`);
    }
  } finally {
    await guard.release().catch(() => undefined);
    await guard.lag(0);
    await own.send('Target.closeTarget', { targetId });
  }
}

async function runInput(guard, path, variant, origin) {
  const id = `bf-input-${path}-${variant}-${origin}-${Date.now()}`;
  const { targetId } = await prepare(origin, 'back', id);
  try {
    const attached = await guard.send('Target.attachToTarget', { targetId, flatten: true });
    assert.equal(attached.error, undefined, clipped(attached));
    const session = attached.result.sessionId;
    await guard.send('Page.enable', {}, session);
    await guard.send('Runtime.enable', {}, session);
    const control = await guard.send(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
      session
    );
    const href = control.result?.result?.value;
    assert.equal(typeof href, 'string', `ordinary page: ${clipped(control)}`);
    await guard.lag(variant === 'lagging' ? READ_LAG : 0);
    await guard.inject(
      JSON.stringify({
        method: 'Page.frameStartedNavigating',
        sessionId: session,
        params: {
          frameId: targetId,
          url: href,
          loaderId: id,
          navigationType: 'historyDifferentDocument',
        },
      })
    );
    await pause(variant === 'lagging' ? READ_LAG + 400 : 200);
    const answer = await guard.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      session
    );
    const kind = verdict(answer);
    await guard.inject(
      JSON.stringify({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: { id: targetId, url: href } },
      })
    );
    await pause(variant === 'lagging' ? READ_LAG + 400 : 200);
    const after = await guard.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 1, y: 1 },
      session
    );
    const opened = verdict(after);
    const line = [
      'BFINPUT',
      path,
      variant,
      origin,
      'back',
      `input=${kind}`,
      `after=${opened}`,
      kind === 'refused' && opened === 'answered' ? 'pass' : 'GAP',
    ].join(' ');
    console.log(line);
    if (kind !== 'refused' || opened !== 'answered') {
      throw new Error(`${line}\nheld=${clipped(answer)}\nopened=${clipped(after)}`);
    }
  } finally {
    await guard.lag(0);
    await own.send('Target.closeTarget', { targetId });
  }
}

async function matrix(t, path, proxy) {
  const guard = await guardPage(t, proxy);
  const wide =
    process.env.BF_HELD !== 'only' &&
    process.env.BF_INPUT !== 'only' &&
    process.env.BF_EFFECT !== 'only';
  if (wide) {
    for (const variant of ['prompt', 'lagging']) {
      await t.test(`${path} ${variant}`, async () => {
        for (let n = 0; n < RUNS; n += 1) {
          const [origin, direction] = CASES[n % CASES.length];
          await runOnce(guard, path, variant, origin, direction, n);
        }
      });
    }
  }
  if (process.env.BF_INPUT !== 'only' && process.env.BF_EFFECT !== 'only') {
    for (const variant of ['prompt', 'lagging']) {
      await t.test(`${path} ${variant} held`, async () => {
        await runHeld(guard, path, variant, 'seven');
      });
    }
  }
  if (process.env.BF_EFFECT !== 'only') {
    for (const variant of ['prompt', 'lagging']) {
      await t.test(`${path} ${variant} input`, async () => {
        await runInput(guard, path, variant, 'seven');
      });
    }
  }
  if (process.env.BF_HELD !== 'only' && process.env.BF_INPUT !== 'only') {
    for (const variant of ['prompt', 'lagging']) {
      await t.test(`${path} ${variant} effect`, async () => {
        await runAbsent(guard, path, variant, 'seven');
      });
    }
  }
}

function bytePipe() {
  const chunks = [];
  let waiting = null;
  let closed = false;
  return {
    write(chunk) {
      if (closed) return Promise.resolve();
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(chunk);
      } else chunks.push(chunk);
      return Promise.resolve();
    },
    read() {
      if (chunks.length) return Promise.resolve(chunks.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(null);
      }
    },
  };
}

function linkStreams() {
  const toPeer = bytePipe();
  const toGuard = bytePipe();
  return {
    guard: {
      write: (chunk) => toPeer.write(chunk),
      read: () => toGuard.read(),
      close() {
        toPeer.close();
        toGuard.close();
      },
      closeWrite: () => toPeer.close(),
    },
    peer: {
      write: (chunk) => toGuard.write(chunk),
      read: () => toPeer.read(),
      close() {
        toPeer.close();
        toGuard.close();
      },
      closeWrite: () => toGuard.close(),
    },
  };
}

function frameText(text) {
  const body = new TextEncoder().encode(text);
  const framed = new Uint8Array(4 + body.length);
  new DataView(framed.buffer).setUint32(0, body.length);
  framed.set(body, 4);
  return framed;
}

function reorder(emit) {
  let held = null;
  let generation = 0;
  return (payload) => {
    if (held === null) {
      held = payload;
      const generationNow = ++generation;
      queueMicrotask(() => {
        if (generation !== generationNow || held === null) return;
        const first = held;
        held = null;
        emit(first);
      });
      return;
    }
    const first = held;
    held = null;
    generation += 1;
    emit(payload);
    emit(first);
  };
}

async function readFrames(stream, onText) {
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  const size = () => new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
  for (;;) {
    while (buffer.length < 4 || buffer.length < 4 + size()) {
      const chunk = await stream.read();
      if (chunk === null) return;
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
    }
    const length = size();
    onText(decoder.decode(buffer.subarray(4, 4 + length)));
    buffer = buffer.subarray(4 + length);
  }
}

function burst(send) {
  return async (session, frameId, expression, worldName) => {
    const evaluate = send(
      'Runtime.evaluate',
      { expression, returnByValue: true, userGesture: true },
      session,
      8000
    );
    const document = send('DOM.getDocument', { depth: 0 }, session, 8000);
    const world = send('Page.createIsolatedWorld', { frameId, worldName }, session, 8000);
    const [evaluateA, documentA, worldA] = await Promise.all([evaluate, document, world]);
    const contextId = worldA.result?.executionContextId;
    const worldEval =
      contextId === undefined
        ? null
        : await send(
            'Runtime.evaluate',
            { expression, contextId, returnByValue: true },
            session,
            8000
          );
    return { evaluate: evaluateA, document: documentA, world: worldA, worldEval };
  };
}

async function guardLink(t) {
  const streams = linkStreams();
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  t.after(() => {
    socket.close();
    streams.peer.close();
  });
  let holding = false;
  let sawHold = false;
  const parked = [];
  let captured = null;
  const noteHold = () => {
    sawHold = true;
    captured?.();
    captured = null;
  };
  const toChrome = reorder((text) => {
    if (holding) {
      let message = null;
      try {
        message = JSON.parse(text);
      } catch {
        message = null;
      }
      if (
        message?.method === 'Runtime.evaluate' &&
        String(message.params?.expression ?? '').includes('BFHOLD')
      ) {
        parked.push(text);
        noteHold();
        return;
      }
    }
    if (socket.readyState === 1) socket.send(text);
  });
  const toGuard = reorder((text) => {
    void streams.peer.write(frameText(text));
  });
  socket.onmessage = ({ data }) => toGuard(String(data));
  void readFrames(streams.peer, (text) => toChrome(text)).catch(() => {});
  const raw = cdpConnection(streams.guard);
  let lag = 0;
  let handler = null;
  Object.defineProperty(raw, 'onmessage', {
    configurable: true,
    get() {
      return handler;
    },
    set(next) {
      handler = (text) => {
        let delay = false;
        if (lag) {
          try {
            const message = JSON.parse(text);
            delay = message.id === undefined && typeof message.method === 'string';
          } catch {
            delay = false;
          }
        }
        if (delay) setTimeout(() => next(text), lag);
        else next(text);
      };
    },
  });
  const connection = guardProtected(raw, SEVEN);
  const pending = new Map();
  const seen = [];
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    seen.push(message);
  };
  const send = (method, params = {}, sessionId = undefined, wait = 8000) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} got no answer` } });
      }, wait);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return {
    send,
    events: () => seen,
    lag: (ms) => {
      lag = ms;
    },
    burst: burst(send),
    inject(text) {
      handler?.(text);
      return Promise.resolve();
    },
    hold() {
      holding = true;
      return Promise.resolve();
    },
    held() {
      return sawHold
        ? Promise.resolve()
        : new Promise((resolve) => {
            captured = resolve;
          });
    },
    release() {
      holding = false;
      const queued = parked.splice(0);
      for (const text of queued) {
        if (socket.readyState === 1) socket.send(text);
      }
      return Promise.resolve();
    },
  };
}

const ONLY = process.env.BF_ONLY ?? '';

if (ONLY === '' || ONLY === 'extension') {
  test('bfcache restore refuses evaluate, document and isolated world on the extension path', {
    timeout: 20 * 60 * 1000,
  }, async (t) => {
    await matrix(t, 'extension', null);
  });
}

if (ONLY === '' || ONLY === 'proxy') {
  test('bfcache restore refuses evaluate, document and isolated world on the proxy path', {
    timeout: 20 * 60 * 1000,
  }, async (t) => {
    const proxy = await startProxy({
      port: 0,
      origins: [SEVEN],
      cdp: `http://127.0.0.1:${port}`,
      kernelPort: null,
      log: () => {},
    });
    t.after(() => proxy.close());
    await matrix(t, 'proxy', { url: proxy.url, key: proxy.key });
  });
}

if (ONLY === '' || ONLY === 'link') {
  test('bfcache restore refuses evaluate, document and isolated world on the link path', {
    timeout: 20 * 60 * 1000,
  }, async (t) => {
    const guard = await guardLink(t);
    const wide =
      process.env.BF_HELD !== 'only' &&
      process.env.BF_INPUT !== 'only' &&
      process.env.BF_EFFECT !== 'only';
    if (wide) {
      for (const variant of ['prompt', 'lagging']) {
        await t.test(`link ${variant}`, async () => {
          for (let n = 0; n < RUNS; n += 1) {
            const [origin, direction] = CASES[n % CASES.length];
            await runOnce(guard, 'link', variant, origin, direction, n);
          }
        });
      }
    }
    if (process.env.BF_INPUT !== 'only' && process.env.BF_EFFECT !== 'only') {
      for (const variant of ['prompt', 'lagging']) {
        await t.test(`link ${variant} held`, async () => {
          await runHeld(guard, 'link', variant, 'seven');
        });
      }
    }
    if (process.env.BF_EFFECT !== 'only') {
      for (const variant of ['prompt', 'lagging']) {
        await t.test(`link ${variant} input`, async () => {
          await runInput(guard, 'link', variant, 'seven');
        });
      }
    }
    if (process.env.BF_HELD !== 'only' && process.env.BF_INPUT !== 'only') {
      for (const variant of ['prompt', 'lagging']) {
        await t.test(`link ${variant} effect`, async () => {
          await runAbsent(guard, 'link', variant, 'seven');
        });
      }
    }
  });
}
