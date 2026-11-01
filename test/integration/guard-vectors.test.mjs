import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { after, test } from 'node:test';
import { protection, redacting } from '../../src/seed/guard.js';
import { boot } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { linkNode } from './linked-node.mjs';

const LAG = 8000;
const CHOSEN = process.env.GUARD_VARIANTS?.split(',').filter(Boolean) ?? null;
const chosen = (detach) => !CHOSEN?.length || CHOSEN.includes(detach);
const DETACH = [
  ['prompt', 0],
  ['lagging', LAG],
].filter(([detach]) => chosen(detach));
const once = chosen('prompt') ? test : () => {};
const SETTINGS =
  /^slicc: refused: settings for a whole session \(headers, user agent, locale, time zone, cache, network conditions, blocked URLs, emulation\)/;
const SCRIPTS =
  /^slicc: refused: scripts and bindings for later documents could run in seven’s pages or the vault/;
const DEBUGGER = /^slicc: refused: breakpoints could run in seven’s pages or the vault/;
const PROTECTED =
  'slicc: refused: seven’s own pages and the vault are out of reach of browser automation';
const UNFLAT =
  'slicc: refused: the guard only hands out flattened sessions, so attach with flatten: true and send commands with a sessionId';
const UNGUARDED =
  'slicc: refused: the guard couldn’t keep seven’s pages and the vault out of this tab, so it refuses commands there';
const UNSEEN = 'slicc: refused: this request wasn’t seen, so it could be seven’s or the vault’s';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const beacons = [];
const heard = [];
const page = (body, head = '') =>
  `<!doctype html><html><head>${head}<title>STAND</title></head><body>${body}<script>console.log('STAND-CONSOLE ' + location.host);document.documentElement.setAttribute('data-locale', Intl.DateTimeFormat().resolvedOptions().locale);document.documentElement.setAttribute('data-tz', Intl.DateTimeFormat().resolvedOptions().timeZone);document.documentElement.setAttribute('data-online', String(navigator.onLine));new Image().src = 'http://localhost:${standPort}/pixel' + location.search;</script></body></html>`;
const SVG = (width) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1"><rect width="${width}" height="1"/></svg>`;
const CSP = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`;
const stand = createHttp((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  heard.push({
    host: url.host,
    path: `${url.pathname}${url.search}`,
    agent: req.headers['x-agent'] ?? null,
    ua: req.headers['user-agent'] ?? '',
    lang: req.headers['accept-language'] ?? '',
    cache: req.headers['cache-control'] ?? '',
  });
  if (url.pathname === '/beacon') {
    beacons.push({ id: url.searchParams.get('id'), host: url.searchParams.get('host') });
    res.writeHead(204, { 'access-control-allow-origin': '*' });
    return res.end();
  }
  if (url.pathname === '/hang') return;
  if (url.pathname === '/bounce') {
    const to = JSON.stringify(url.searchParams.get('to'));
    const ms = Number(url.searchParams.get('ms') ?? 1000);
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<!doctype html><title>bounce</title><script>setTimeout(() => { location.href = ${to}; }, ${ms});</script>`
    );
  }
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: url.searchParams.get('to') });
    return res.end();
  }
  const open = { 'access-control-allow-origin': '*' };
  if (url.pathname === '/data') {
    res.writeHead(200, { ...open, 'content-type': 'text/plain' });
    return res.end(`real-${url.searchParams.get('n')}`);
  }
  if (url.pathname === '/img') {
    res.writeHead(200, { ...open, 'content-type': 'image/svg+xml' });
    return res.end(SVG(1));
  }
  if (url.pathname.startsWith('/auth/')) {
    const credentialed = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-credentials': 'true',
      'content-type': 'text/plain',
    };
    if (!req.headers.authorization) {
      res.writeHead(401, { ...credentialed, 'www-authenticate': `Basic realm="${url.pathname}"` });
      return res.end('denied');
    }
    res.writeHead(200, credentialed);
    return res.end('authed');
  }
  const cookie = { 'set-cookie': 'pk=1; Path=/', 'content-type': 'text/html' };
  if (url.pathname === '/csp') {
    res.writeHead(200, cookie);
    return res.end(
      page(`<script>document.documentElement.setAttribute('data-k', 'inline')</script>`, CSP)
    );
  }
  if (url.pathname === '/doc' || url.pathname === '/vault') {
    res.writeHead(200, cookie);
    return res.end(page('<h1>STAND-BODY</h1>'));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('missing');
});
await new Promise((resolve) => stand.listen(0, '127.0.0.1', resolve));
const standPort = stand.address().port;
const PLAIN = `http://localhost:${standPort}`;
const OTHER = `http://plain.test:${standPort}`;
const VAULT = `http://vault.sliccy.ai:${standPort}`;
const ABC = `http://abc.sliccy.ai:${standPort}`;

const chrome = await launch({
  tools: false,
  args: [
    '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1, MAP plain.test 127.0.0.1, MAP abc.sliccy.ai 127.0.0.1',
  ],
});
const { port } = await devtools(chrome);
const SEVEN = new URL(chrome.url).origin;
after(() => {
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

async function tab(url = `${PLAIN}/doc`) {
  const { result } = await own.send('Target.createTarget', { url });
  for (let n = 0; n < 50; n += 1) {
    const { result: info } = await own.send('Target.getTargetInfo', { targetId: result.targetId });
    if (
      info?.targetInfo?.url.startsWith(url.split('?')[0]) &&
      !info.targetInfo.url.endsWith('about:blank')
    )
      break;
    await pause(100);
  }
  await pause(300);
  return result.targetId;
}
const closeAll = async (ids) => {
  for (const targetId of ids) await own.send('Target.closeTarget', { targetId });
};

async function harness(targetId) {
  const { result } = await own.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = result.sessionId;
  const send = (method, params) => own.send(method, params, sessionId);
  await send('Runtime.enable');
  await send('Page.enable');
  return { sessionId, send };
}

async function popupReport(guard, popup, answer) {
  const report = {
    afterAttachReply: true,
    observedAt: Date.now(),
    discoveredUrl: popup.url,
    answer,
  };
  const capture = (promise) => promise.catch((error) => ({ error: { message: String(error) } }));
  let sessionId;
  try {
    const attached = await capture(
      own.send('Target.attachToTarget', {
        targetId: popup.targetId,
        flatten: true,
      })
    );
    report.harnessAttach = attached;
    sessionId = attached.result?.sessionId;
    const [target, tree, guardedTarget, guardedTree, guardedDOM] = await Promise.all([
      capture(own.send('Target.getTargetInfo', { targetId: popup.targetId })),
      sessionId ? capture(own.send('Page.getFrameTree', {}, sessionId)) : attached,
      capture(guard.send('Target.getTargetInfo', { targetId: popup.targetId }, undefined, 3000)),
      answer.result?.sessionId
        ? capture(guard.send('Page.getFrameTree', {}, answer.result.sessionId, 3000))
        : null,
      answer.result?.sessionId
        ? capture(guard.send('DOM.getDocument', { depth: 0 }, answer.result.sessionId, 3000))
        : null,
    ]);
    const frameTree = tree.result?.frameTree;
    const frame = frameTree?.frame;
    const frames = (node) =>
      node?.frame ? [node.frame, ...(node.childFrames ?? []).flatMap(frames)] : [];
    const is = protection(SEVEN);
    const live = frames(frameTree).some(
      (entry) => is.url(entry.url) || is.url(entry.securityOrigin)
    );
    const error = frame?.url?.startsWith('chrome-error:') || frame?.unreachableUrl;
    report.target = target;
    report.frameTree = frameTree ?? tree;
    report.loaderId = frame?.loaderId ?? null;
    report.securityOrigin = frame?.securityOrigin ?? null;
    report.guardedTarget = guardedTarget;
    report.guardedTree = guardedTree;
    report.guardedDOM = guardedDOM && {
      error: guardedDOM.error,
      hasRoot: Boolean(guardedDOM.result?.root),
    };
    report.pathObserved = live
      ? 'protected frame after attach reply'
      : error
        ? guardedDOM?.error?.message === PROTECTED
          ? 'sealed error/recovery candidate'
          : 'error document after attach reply'
        : frame?.url === BLANKED
          ? 'blocked blank after attach reply'
          : frame?.url?.startsWith('about:blank')
            ? 'ordinary blank after attach reply'
            : 'unknown';
  } catch (error) {
    report.diagnosticError = String(error);
  } finally {
    if (sessionId) {
      try {
        report.detached = await own.send('Target.detachFromTarget', { sessionId });
      } catch (error) {
        report.detachError = String(error);
      }
    }
  }
  report.observedUntil = Date.now();
  return report;
}

async function readAttribute(prefix, name = 'data-k', ms = 4000) {
  return readIn(
    prefix,
    `location.protocol === 'chrome-error:' ? null : (document.documentElement?.getAttribute(${JSON.stringify(name)}) ?? null)`,
    ms
  );
}

const loaded = async (prefix, ms = 8000) =>
  (await readIn(prefix, "document.title === 'STAND' ? 'loaded' : null", ms)).value === 'loaded';

const served = (url, mark) => {
  const at = new URL(url);
  if (at.origin === SEVEN) return chrome.requests.slice(mark).includes(at.pathname);
  return heard.some((hit) => hit.host === at.host && hit.path === `${at.pathname}${at.search}`);
};

const BLANKED = 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E';
const stopped = (href) => String(href).startsWith('chrome-error://') || href === BLANKED;

async function errorPage(targetId, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const attached = await own.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    if (sessionId) {
      const answer = await own.send(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        sessionId
      );
      await own.send('Target.detachFromTarget', { sessionId });
      if (stopped(answer.result?.result?.value)) return true;
    }
    await pause(200);
  }
  return false;
}

async function keptOut(id, { targetId, url, mark, trigger = 'href', lag = 0 }) {
  if (trigger === 'iframe') await pause(lag + 3000);
  else
    assert.ok(
      await errorPage(targetId, lag + 15000),
      `${id}: the touched tab shows Chrome's error page, read through the harness's own CDP`
    );
  assert.equal(
    served(url, mark),
    false,
    `${id}: the protected document was never requested from the touched tab`
  );
}

async function kept(guard, id, { targetId, session, url, lag = 0 }) {
  assert.equal(
    await loaded(url, 1500),
    false,
    `${id}: the protected document never loaded, read through the harness's own CDP`
  );
  const { result } = await own.send('Target.getTargetInfo', { targetId });
  assert.ok(result?.targetInfo, `${id}: the tab is kept`);
  let href = null;
  for (const end = Date.now() + lag + 5000; !stopped(href); ) {
    href = (
      await guard.send(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        session
      )
    ).result?.result?.value;
    if (Date.now() > end) break;
    await pause(200);
  }
  assert.ok(
    stopped(href),
    `${id}: the client's session is kept, on a page the guard left (${href})`
  );
  const info = await guard.send('Target.getTargetInfo', { targetId });
  assert.ok(
    stopped(info.result?.targetInfo?.url),
    `${id}: the client can still name the tab, and sees the page the guard left, not the URL it failed (${JSON.stringify(info.result?.targetInfo?.url ?? info.error)})`
  );
}

async function readIn(prefix, expression, ms) {
  const deadline = Date.now() + ms;
  let last = { found: false, value: null };
  while (Date.now() < deadline) {
    const { result } = await own.send('Target.getTargets');
    const target = (result?.targetInfos ?? []).find(
      (info) => (info.type === 'page' || info.type === 'iframe') && info.url.startsWith(prefix)
    );
    if (target) {
      const attached = await own.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      const sessionId = attached.result?.sessionId;
      if (sessionId) {
        const answer = await own.send(
          'Runtime.evaluate',
          {
            expression,
            returnByValue: true,
          },
          sessionId
        );
        await own.send('Target.detachFromTarget', { sessionId });
        last = { found: true, value: answer.result?.result?.value ?? null };
        if (last.value !== null) return last;
      }
    }
    await pause(200);
  }
  return last;
}

const marker = (id) =>
  `(function k(){var d=document.documentElement;if(!d){return setTimeout(k,0);}if(!d.hasAttribute('data-k')){d.setAttribute('data-k',${JSON.stringify(id)});fetch('http://localhost:${standPort}/beacon?id='+encodeURIComponent(${JSON.stringify(id)})+'&host='+encodeURIComponent(location.host),{mode:'no-cors'});}})()`;

async function guardPage(t, lag, path = null, lens = null, route = null) {
  const seven = await chrome.page(t);
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  t.after(() => socket.close());
  const asked = new Map();
  socket.onmessage = ({ data }) => {
    let text = data;
    if (lens) {
      const message = JSON.parse(data);
      const method = asked.get(message.id);
      asked.delete(message.id);
      text = JSON.stringify(lens(message, method));
    }
    void seven.evaluate((message) => window.cdpIn(message), text).catch(() => false);
  };
  const stalls = [];
  await seven.expose('cdpOut', (command) => {
    const stall = stalls.findIndex(
      ({ method }) =>
        command.method === method &&
        (command.params?.patterns ?? []).some((pattern) => pattern.resourceType === 'Document')
    );
    if (stall >= 0) {
      const [{ how }] = stalls.splice(stall, 1);
      if (how === 'fail') {
        const answer = JSON.stringify({ id: command.id, error: { message: 'failed by the test' } });
        void seven.evaluate((message) => window.cdpIn(message), answer).catch(() => false);
      }
      return;
    }
    if (lens) asked.set(command.id, command.method);
    const send = () => socket.readyState === 1 && socket.send(JSON.stringify(command));
    if (lag && command.method === 'Target.detachFromTarget') setTimeout(send, lag);
    else send();
  });
  await seven.init(() => {
    globalThis.sliccKernelDebug = true;
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
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
    };
    Object.defineProperty(globalThis, 'sliccExtension', {
      value: Object.freeze({
        version: '7.10.0',
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
  if (path === 'link') await linkNode(t, seven, port);
  await seven.evaluate(
    async ({ path, route }) => {
      const { guardProtected } = await import(new URL('guard.js', location.href).href);
      const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
      window.armDelay = 0;
      const slowed = (connection) => {
        const send = connection.send.bind(connection);
        connection.send = (text) => {
          const { method, params } = JSON.parse(text);
          const arming =
            method === 'Fetch.enable' &&
            (params?.patterns ?? []).some((pattern) => pattern.resourceType === 'Document');
          if (arming && Date.now() < window.armDelay) setTimeout(() => send(text), 4000);
          else send(text);
        };
        return connection;
      };
      const routed = async () => {
        if (path === 'link') return slowed(await globalThis.sliccLinkedBrowsers()[0].open());
        return extensionConnection(globalThis.sliccExtension.cdp);
      };
      const connection = guardProtected(await routed(), location.origin, new Map(), route);
      const pending = new Map();
      const events = [];
      const messages = [];
      let next = 0;
      connection.onmessage = (text) => {
        const message = JSON.parse(text);
        messages.push(message);
        if (message.id !== undefined) {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
          return;
        }
        events.push(message);
        for (const handler of handlers) handler(message);
      };
      const handlers = new Set();
      window.guarded = {
        events,
        messages,
        handlers,
        send: (method, params = {}, sessionId = undefined, wait = 20000) =>
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
    },
    { path, route }
  );
  const send = (method, params, sessionId, wait) =>
    seven.evaluate(
      ([m, p, s, w]) => window.guarded.send(m, p ?? {}, s ?? undefined, w ?? 20000),
      [method, params ?? {}, sessionId ?? null, wait ?? 20000]
    );
  const go = (expression, sessionId) =>
    send('Runtime.evaluate', { expression, userGesture: true }, sessionId, 3000);
  const events = () => seven.evaluate(() => window.guarded.events);
  const attach = async (targetId) => {
    const answer = await send('Target.attachToTarget', { targetId, flatten: true });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    await send('Page.enable', {}, answer.result.sessionId);
    await send('Runtime.enable', {}, answer.result.sessionId);
    return answer.result.sessionId;
  };
  const stall = (how) => stalls.push({ method: 'Fetch.enable', how });
  const slowArm = (ms) =>
    seven.evaluate((until) => {
      window.armDelay = until;
    }, Date.now() + ms);
  return { seven, send, go, events, attach, stall, slowArm };
}

const targets = () => ({
  seven: (path) => `${SEVEN}${path === '/csp' ? '/probe-csp.html' : '/probe-doc.html'}`,
  vault: (path) => `${VAULT}${path}`,
});
const sevenPages = (seven) => {
  const body = (head, inline) =>
    `<!doctype html><html><head>${head}<title>STAND</title></head><body><h1>STAND-BODY</h1>${inline}<script>console.log('STAND-CONSOLE ' + location.host);document.documentElement.setAttribute('data-locale', Intl.DateTimeFormat().resolvedOptions().locale);document.documentElement.setAttribute('data-tz', Intl.DateTimeFormat().resolvedOptions().timeZone);document.documentElement.setAttribute('data-online', String(navigator.onLine));new Image().src = 'http://localhost:${standPort}/pixel' + location.search;</script></body></html>`;
  chrome.overrides.set('/probe-doc.html', body('', ''));
  chrome.overrides.set(
    '/probe-csp.html',
    body(CSP, `<script>document.documentElement.setAttribute('data-k', 'inline')</script>`)
  );
  void seven;
};

const TRIGGERS = {
  href: (to) => `location.href = ${JSON.stringify(to)}`,
  302: (to) =>
    `location.href = ${JSON.stringify(`${PLAIN}/redirect?to=${encodeURIComponent(to)}`)}`,
  popup: (to) => `window.open(${JSON.stringify(to)})`,
  iframe: (to) =>
    `document.body.append(Object.assign(document.createElement('iframe'), { src: ${JSON.stringify(to)} }))`,
};
const VECTOR = { href: 'C1.href', 302: 'C2.302', popup: 'C3.popup', iframe: 'C4.iframe' };

const registrations = {
  C: (id) => [
    ['Page.addScriptToEvaluateOnNewDocument', { source: marker(id), runImmediately: true }],
  ],
  basic: (id) => [['Page.addScriptToEvaluateOnNewDocument', { source: marker(id) }]],
  world: (id) => [
    ['Page.addScriptToEvaluateOnNewDocument', { source: marker(id), worldName: 'kworld' }],
  ],
  E1: (id) => [['Page.addScriptToEvaluateOnLoad', { scriptSource: marker(id) }]],
};

async function controlThroughHarness(id, setup, trigger, to, open) {
  const created = [];
  try {
    const targetId = await tab(`${PLAIN}/doc`);
    created.push(targetId);
    const { send, sessionId } = await harness(targetId);
    for (const [method, params] of setup(id)) {
      const answer = await send(method, params);
      assert.equal(
        answer.error,
        undefined,
        `${method} through the harness: ${JSON.stringify(answer.error)}`
      );
    }
    let instrumenting = null;
    if (open) {
      const watcher = cdp();
      const auto = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
      const watched = (
        await watcher.send('Target.attachToTarget', { targetId: created[0], flatten: true })
      ).result.sessionId;
      await watcher.send('Target.setAutoAttach', auto, watched);
      await watcher.send('Target.setAutoAttach', auto);
      const done = new Set();
      let from = 0;
      let stop = false;
      const loop = (async () => {
        while (!stop) {
          const batch = watcher.events.slice(from);
          from += batch.length;
          for (const event of batch) {
            if (event.method !== 'Target.attachedToTarget') continue;
            const child = event.params.sessionId;
            if (done.has(child)) continue;
            done.add(child);
            await watcher.send('Page.enable', {}, child);
            await watcher.send('Runtime.enable', {}, child);
            for (const [method, params] of setup(id)) await watcher.send(method, params, child);
            await watcher.send('Runtime.runIfWaitingForDebugger', {}, child);
          }
          await pause(20);
        }
      })();
      instrumenting = {
        stop: async () => {
          stop = true;
          await loop;
          watcher.close();
        },
      };
    }
    try {
      await send('Runtime.evaluate', { expression: TRIGGERS[trigger](to), userGesture: true });
      return await readAttribute(to, 'data-k', 8000);
    } finally {
      await instrumenting?.stop();
    }
  } finally {
    const { result } = await own.send('Target.getTargets');
    const extra = result.targetInfos.filter(
      (info) => info.type === 'page' && info.url.startsWith(to.split('?')[0])
    );
    await closeAll([...created, ...extra.map((info) => info.targetId)]);
  }
}

const instrumentOn = (guard, setup) =>
  guard.seven.evaluate((setup) => {
    const { guarded } = window;
    for (const handler of guarded.handlers) guarded.handlers.delete(handler);
    if (!setup) return;
    guarded.handlers.add((event) => {
      if (event.method !== 'Target.attachedToTarget') return;
      const child = event.params.sessionId;
      void (async () => {
        await guarded.send('Page.enable', {}, child, 3000);
        await guarded.send('Runtime.enable', {}, child, 3000);
        for (const [method, params] of setup) await guarded.send(method, params, child, 3000);
        await guarded.send('Runtime.runIfWaitingForDebugger', {}, child, 3000);
      })();
    });
  }, setup);

for (const [detach, lag] of DETACH) {
  test(`C1–C4 and E1 at registration, ${detach} detach`, { timeout: 20 * 60 * 1000 }, async (t) => {
    const guard = await guardPage(t, lag);
    sevenPages(guard.seven);
    const rows = [];
    for (const trigger of ['href', 302, 'popup', 'iframe']) {
      rows.push([VECTOR[trigger], registrations.C, trigger]);
      if (trigger !== 'popup') {
        rows.push([`${VECTOR[trigger]}-basic`, registrations.basic, trigger]);
        rows.push([`${VECTOR[trigger]}-world`, registrations.world, trigger]);
      }
    }
    rows.push(['E1', registrations.E1, 'href']);
    for (const [vector, setup, trigger] of rows) {
      const children = trigger === 'popup' || trigger === 'iframe';
      for (const [name, at] of Object.entries(targets())) {
        const id = `${vector}.${name}`;
        const to = at('/doc');
        await t.test(`${id} control`, async () => {
          const onPlain = await controlThroughHarness(
            `${id}:plain`,
            setup,
            trigger,
            `${OTHER}/doc?c=${id}`,
            children
          );
          assert.equal(onPlain.value, `${id}:plain`, `${id} control on the plain stand-in`);
          const onProtected = await controlThroughHarness(
            `${id}:protected`,
            setup,
            trigger,
            `${to}?c=${id}`,
            children
          );
          assert.equal(
            onProtected.value,
            `${id}:protected`,
            `${id} control on the protected stand-in`
          );
          assert.ok(
            beacons.some((b) => b.id === `${id}:plain`),
            `${id} control beacon, plain`
          );
          assert.ok(
            beacons.some((b) => b.id === `${id}:protected`),
            `${id} control beacon, protected`
          );
        });
        await t.test(`${id} protected`, async () => {
          const targetId = await tab(`${PLAIN}/doc`);
          const url = `${to}?p=${id}`;
          const auto = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
          try {
            const session = await guard.attach(targetId);
            for (const [method, params] of setup(id)) {
              const answer = await guard.send(method, params, session);
              assert.match(
                answer.error?.message ?? '',
                SCRIPTS,
                `${method}: the guard's own refusal`
              );
            }
            if (children) {
              await instrumentOn(guard, setup(id));
              assert.equal(
                (await guard.send('Target.setDiscoverTargets', { discover: true })).error,
                undefined
              );
              assert.equal(
                (await guard.send('Target.setAutoAttach', auto, session)).error,
                undefined
              );
              assert.equal((await guard.send('Target.setAutoAttach', auto)).error, undefined);
            }
            const before = (await guard.events()).length;
            const mark = chrome.requests.length;
            const ran = await guard.go(TRIGGERS[trigger](url), session);
            let popup = null;
            if (trigger === 'popup') {
              assert.equal(ran.error, undefined, `${id}: the trigger ran`);
              for (const end = Date.now() + lag + 15000; !popup && Date.now() < end; ) {
                const { result } = await own.send('Target.getTargets');
                popup = (result?.targetInfos ?? []).find(
                  (info) => info.type === 'page' && info.openerId === targetId
                );
                if (!popup) await pause(200);
              }
              assert.ok(
                popup,
                `${id}: the popup opened, found by its opener through the harness's own CDP`
              );
              await pause(lag + 3000);
              const attached = await guard.send('Target.attachToTarget', {
                targetId: popup.targetId,
                flatten: true,
              });
              const report =
                attached.error?.message === PROTECTED
                  ? null
                  : await popupReport(guard, popup, attached);
              const failures = [];
              let attribute;
              try {
                attribute = await readAttribute(url, 'data-k', 1500);
              } catch (error) {
                failures.push(error);
              }
              const beacon = beacons.some((b) => b.id === id);
              if (report) {
                try {
                  console.log(
                    'guard popup diagnostic',
                    JSON.stringify({ id, ...report, attribute, beacon })
                  );
                } catch (error) {
                  failures.push(error);
                }
              }
              for (const check of [
                () =>
                  assert.equal(
                    attribute?.value,
                    null,
                    `${id}: no attribute in the protected popup`
                  ),
                () => assert.ok(!beacon, `${id}: no beacon from the protected popup`),
                () =>
                  assert.equal(
                    attached.error?.message,
                    PROTECTED,
                    `${id}: the client can't attach to the protected popup`
                  ),
              ]) {
                try {
                  check();
                } catch (error) {
                  failures.push(error);
                }
              }
              if (failures.length === 1) throw failures[0];
              if (failures.length > 1)
                throw new AggregateError(failures, `${id}: popup checks failed`);
            } else {
              await keptOut(id, { targetId, url, mark, trigger, lag });
            }
            const later = (await guard.events()).slice(before);
            assert.ok(
              !JSON.stringify(later).includes(url),
              `${id}: nothing naming the protected document reached the client`
            );
            const { result } = await own.send('Target.getTargets');
            const child =
              popup ?? result.targetInfos.find((info) => children && info.url.startsWith(url));
            if (child) {
              const about = later.filter((event) => JSON.stringify(event).includes(child.targetId));
              assert.deepEqual(
                about.filter((event) => event.method === 'Target.attachedToTarget'),
                [],
                `${id}: the protected ${trigger} was never attached to the client`
              );
              assert.ok(
                !about.some((event) => JSON.stringify(event).includes(new URL(to).host)),
                `${id}: no target event shows the protected ${trigger}'s origin (${JSON.stringify(about).slice(0, 400)})`
              );
              const leaks = about.filter((event) => {
                const info = event.params?.targetInfo ?? {};
                return (
                  (info.url &&
                    info.url !== 'about:blank' &&
                    !/^https?:\/\/[^/]+$/.test(info.url)) ||
                  (info.title && info.title !== info.url && info.title !== 'about:blank') ||
                  /"frame":|"context":|executionContext|STAND/.test(JSON.stringify(event))
                );
              });
              assert.deepEqual(
                leaks.map((event) => event.method),
                [],
                `${id}: events naming the ${trigger}'s target carry no url, title, frame or execution context (${JSON.stringify(leaks).slice(0, 600)})`
              );
            }
          } finally {
            if (children) {
              await guard.send('Target.setAutoAttach', {
                autoAttach: false,
                waitForDebuggerOnStart: false,
                flatten: true,
              });
              await guard.send('Target.setDiscoverTargets', { discover: false });
              await instrumentOn(guard, null);
            }
            const { result } = await own.send('Target.getTargets');
            const extra = result.targetInfos.filter(
              (info) =>
                info.type === 'page' && (info.url.startsWith(to) || info.openerId === targetId)
            );
            await closeAll([targetId, ...extra.map((info) => info.targetId)]);
          }
        });
      }
    }
  });

  test(`E2–E5, ${detach} detach`, { timeout: 20 * 60 * 1000 }, async (t) => {
    const guard = await guardPage(t, lag, null, null, { kind: 'extension', version: '7.10.1' });
    sevenPages(guard.seven);
    for (const [name, at] of Object.entries(targets())) {
      await t.test(`E2.${name} control`, async () => {
        for (const to of [`${OTHER}/doc?e2`, `${at('/doc')}?e2c`]) {
          const targetId = await tab(`${PLAIN}/doc`);
          try {
            const { send, sessionId } = await harness(targetId);
            assert.equal((await send('Runtime.addBinding', { name: 'kBind' })).error, undefined);
            await send('Page.addScriptToEvaluateOnNewDocument', {
              source: `(function c(){if(window.kBind)kBind('E2 '+location.host);else setTimeout(c,0)})()`,
            });
            const from = own.events.length;
            await send('Runtime.evaluate', { expression: TRIGGERS.href(to) });
            await pause(2500);
            assert.ok(
              own.events
                .slice(from)
                .some(
                  (e) =>
                    e.sessionId === sessionId &&
                    e.method === 'Runtime.bindingCalled' &&
                    e.params.payload === `E2 ${new URL(to).host}`
                ),
              `E2 control binding call from ${to}`
            );
          } finally {
            await closeAll([targetId]);
          }
        }
      });
      await t.test(`E2.${name} protected`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          assert.match(
            (await guard.send('Runtime.addBinding', { name: 'kBind' }, session)).error?.message ??
              '',
            SCRIPTS
          );
          assert.match(
            (
              await guard.send(
                'Page.addScriptToEvaluateOnNewDocument',
                { source: 'kBind(location.host)' },
                session
              )
            ).error?.message ?? '',
            SCRIPTS
          );
          const before = (await guard.events()).length;
          const mark = chrome.requests.length;
          await guard.go(TRIGGERS.href(`${at('/doc')}?e2p`), session);
          await keptOut('E2', { targetId, url: `${at('/doc')}?e2p`, mark, lag });
          await pause(lag ? lag + 2000 : 2500);
          assert.ok(
            !JSON.stringify((await guard.events()).slice(before)).includes(
              new URL(at('/doc')).host
            ),
            'E2: nothing naming the protected host reached the client'
          );
        } finally {
          await closeAll([targetId]);
        }
      });

      await t.test(`E3.${name} control`, async () => {
        for (const to of [`${OTHER}/csp?e3`, `${at('/csp')}?e3c`]) {
          const targetId = await tab(`${PLAIN}/doc`);
          try {
            const { send } = await harness(targetId);
            assert.equal((await send('Page.enable')).error, undefined);
            assert.equal((await send('Page.setBypassCSP', { enabled: true })).error, undefined);
            await send('Runtime.evaluate', { expression: TRIGGERS.href(to) });
            assert.equal(
              (await readAttribute(to)).value,
              'inline',
              `E3 control: CSP bypassed on ${to}`
            );
          } finally {
            await closeAll([targetId]);
          }
        }
      });
      await t.test(`E3.${name} protected`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          assert.match(
            (await guard.send('Page.setBypassCSP', { enabled: true }, session)).error?.message ??
              '',
            SCRIPTS
          );
          const to = at('/csp');
          const mark = chrome.requests.length;
          await guard.go(TRIGGERS.href(`${to}?e3p`), session);
          await keptOut('E3', { targetId, url: `${to}?e3p`, mark, lag });
        } finally {
          await closeAll([targetId]);
        }
      });

      await t.test(`E4.${name} control`, async () => {
        for (const to of [`${OTHER}/doc?e4`, `${at('/doc')}?e4c`]) {
          const targetId = await tab(`${PLAIN}/doc`);
          try {
            const { send, sessionId } = await harness(targetId);
            await send('Page.addScriptToEvaluateOnNewDocument', {
              source: "addEventListener('DOMContentLoaded', () => {})",
            });
            await send('Debugger.enable');
            const condition = `document.documentElement.setAttribute('data-k', 'E4'), false`;
            await send('Debugger.setBreakpointByUrl', {
              urlRegex: '.*',
              lineNumber: 0,
              columnNumber: 0,
              condition,
            });
            await send('DOMDebugger.setEventListenerBreakpoint', { eventName: 'DOMContentLoaded' });
            await send('Debugger.setInstrumentationBreakpoint', {
              instrumentation: 'beforeScriptExecution',
            });
            const from = own.events.length;
            void send('Runtime.evaluate', { expression: TRIGGERS.href(to) });
            const reasons = [];
            let seenTo = from;
            for (const end = Date.now() + 4000; Date.now() < end; ) {
              for (const e of own.events.slice(seenTo)) {
                seenTo += 1;
                if (e.method !== 'Debugger.paused' || e.sessionId !== sessionId) continue;
                reasons.push(e.params.reason);
                await send('Debugger.resume');
              }
              await pause(50);
            }
            await send('Debugger.disable');
            const seen = await readAttribute(to, 'data-k', 2000);
            assert.ok(
              reasons.includes('instrumentation'),
              `E4 control on ${to}: the instrumentation breakpoint paused (${reasons})`
            );
            assert.ok(
              reasons.some((reason) => reason !== 'instrumentation') || seen.value === 'E4',
              `E4 control on ${to}: a breakpoint condition evaluated or a listener breakpoint paused (${reasons})`
            );
          } finally {
            await closeAll([targetId]);
          }
        }
      });
      await t.test(`E4.${name} protected`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          for (const [method, params] of [
            ['Debugger.enable', {}],
            [
              'Debugger.setBreakpointByUrl',
              {
                urlRegex: '.*',
                lineNumber: 0,
                condition: `document.documentElement.setAttribute('data-k','E4')`,
              },
            ],
            ['Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }],
            ['DOMDebugger.setEventListenerBreakpoint', { eventName: 'DOMContentLoaded' }],
          ]) {
            if (
              method === 'Debugger.enable' ||
              method === 'Debugger.setInstrumentationBreakpoint'
            ) {
              assert.equal(
                (await guard.send(method, params, session)).error,
                undefined,
                `${method}: ordinary predecessor admission`
              );
              continue;
            }
            assert.match(
              (await guard.send(method, params, session)).error?.message ?? '',
              DEBUGGER,
              method
            );
          }
          const before = (await guard.events()).length;
          const mark = chrome.requests.length;
          await guard.go(TRIGGERS.href(`${at('/doc')}?e4p`), session);
          await keptOut('E4', { targetId, url: `${at('/doc')}?e4p`, mark, lag });
          await pause(lag ? lag + 2000 : 2500);
          assert.ok(
            !JSON.stringify((await guard.events()).slice(before)).includes(
              new URL(at('/doc')).host
            ),
            'E4: nothing naming the protected host reached the client'
          );
        } finally {
          await closeAll([targetId]);
        }
      });

      await t.test(`E5.${name} control`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          assert.equal((await guard.send('Runtime.enable', {}, session)).error, undefined);
          const before = (await guard.events()).length;
          await guard.go(TRIGGERS.href(`${OTHER}/doc?e5`), session);
          await pause(3000);
          assert.ok(
            (await guard.events())
              .slice(before)
              .some(
                (e) =>
                  e.method === 'Runtime.consoleAPICalled' &&
                  JSON.stringify(e.params.args).includes('STAND-CONSOLE plain.test')
              ),
            'E5 control: the plain page’s console event reaches the client'
          );
        } finally {
          await closeAll([targetId]);
        }
      });
      await t.test(`E5.${name} protected`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          assert.equal((await guard.send('Runtime.enable', {}, session)).error, undefined);
          const live = (await guard.events()).length;
          await guard.go(`console.log('E5-LIVE ${name}')`, session);
          await pause(500);
          assert.ok(
            (await guard.events())
              .slice(live)
              .some(
                (e) =>
                  e.method === 'Runtime.consoleAPICalled' &&
                  JSON.stringify(e.params.args).includes(`E5-LIVE ${name}`)
              ),
            'E5: the session delivers console events before the protected navigation, so the probe is live'
          );
          const before = (await guard.events()).length;
          const to = at('/doc');
          const mark = chrome.requests.length;
          await guard.go(TRIGGERS.href(`${to}?e5p`), session);
          await keptOut('E5', { targetId, url: `${to}?e5p`, mark, lag });
          await kept(guard, 'E5', { targetId, session, url: `${to}?e5p`, lag });
          await pause(lag ? lag + 3000 : 3000);
          const host = new URL(to).host;
          const later = JSON.stringify((await guard.events()).slice(before));
          assert.ok(
            !later.includes(host),
            'E5: nothing naming the protected host reached the client'
          );
        } finally {
          await closeAll([targetId]);
        }
      });
    }
  });

  test(`E6 session overrides, ${detach} detach`, { timeout: 30 * 60 * 1000 }, async (t) => {
    const guard = await guardPage(t, lag);
    sevenPages(guard.seven);
    const offline = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    const overrides = [
      [
        'headers',
        'Network.setExtraHTTPHeaders',
        { headers: { 'X-Agent': 'set-by-agent' } },
        (hit) => hit.agent === 'set-by-agent',
      ],
      [
        'ua.network',
        'Network.setUserAgentOverride',
        { userAgent: 'agent-ua/1' },
        (hit) => hit.ua === 'agent-ua/1',
      ],
      [
        'ua.emulation',
        'Emulation.setUserAgentOverride',
        { userAgent: 'agent-ua/2', acceptLanguage: 'eo' },
        (hit) => hit.ua === 'agent-ua/2',
      ],
      [
        'cache',
        'Network.setCacheDisabled',
        { cacheDisabled: true },
        (hit) => /no-cache/.test(hit.cache),
      ],
      [
        'blockedurls',
        'Network.setBlockedURLs',
        { urlPatterns: [{ urlPattern: '*://*:*/pixel*', block: true }] },
        null,
      ],
      ['netcond', 'Network.emulateNetworkConditions', offline, 'offline'],
      [
        'netcond.rule',
        'Network.emulateNetworkConditionsByRule',
        { matchedNetworkConditions: [{ urlPattern: '', ...offline }] },
        'offline',
      ],
      ['netstate', 'Network.overrideNetworkState', offline, 'data-online'],
      ['locale', 'Emulation.setLocaleOverride', { locale: 'de-CH' }, 'data-locale'],
      ['timezone', 'Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Chatham' }, 'data-tz'],
    ];
    const value = { locale: 'de-CH', timezone: 'Pacific/Chatham', netstate: 'false' };
    const FRAMED = new Set([
      'headers',
      'ua.network',
      'ua.emulation',
      'cache',
      'netcond',
      'netcond.rule',
    ]);
    const where = (name, check) =>
      typeof check === 'function'
        ? { seven: `${ABC}/doc`, vault: `${VAULT}/doc` }[name]
        : targets()[name]('/doc');
    for (const trigger of ['href', 'iframe']) {
      for (const name of ['seven', 'vault']) {
        for (const [key, method, params, check] of overrides) {
          if (trigger === 'iframe' && !FRAMED.has(key)) continue;
          const id = `E6.${key}${trigger === 'iframe' ? '-iframe' : ''}.${name}`;
          const doc = where(name, check);
          const observe = async (to, tag, mark) => {
            const path = new URL(to).pathname;
            if (typeof check === 'function') {
              await pause(2000);
              return heard.some((hit) => hit.path.includes(tag) && check(hit));
            }
            if (check === null || check === 'offline') {
              await pause(2500);
              const arrived =
                heard.some((hit) => hit.path === `${path}?${tag}`) ||
                chrome.requests.slice(mark).some((at) => at.startsWith('/probe-doc'));
              if (check === 'offline') return !arrived;
              return (
                arrived &&
                !heard.some((hit) => hit.path.startsWith('/pixel') && hit.path.includes(tag))
              );
            }
            return (await readAttribute(to, check, 3000)).value === value[key];
          };
          await t.test(`${id} control`, async () => {
            for (const [to, tag] of [
              [`${OTHER}/doc?${id}:plain`, `${id}:plain`],
              [`${doc}?${id}:protected`, `${id}:protected`],
            ]) {
              const targetId = await tab(`${PLAIN}/doc`);
              try {
                const { send } = await harness(targetId);
                await send('Network.enable');
                assert.equal((await send(method, params)).error, undefined, method);
                const mark = chrome.requests.length;
                await send('Runtime.evaluate', { expression: TRIGGERS[trigger](to) });
                assert.ok(await observe(to, tag, mark), `${id} control applied on ${to}`);
              } finally {
                await closeAll([targetId]);
              }
            }
          });
          await t.test(`${id} protected`, async () => {
            const targetId = await tab(`${PLAIN}/doc`);
            try {
              const session = await guard.attach(targetId);
              await guard.send('Network.enable', {}, session);
              assert.match(
                (await guard.send(method, params, session)).error?.message ?? '',
                SETTINGS,
                method
              );
              const tag = `${id}:guard`;
              const to = `${doc}?${tag}`;
              const mark = chrome.requests.length;
              await guard.go(TRIGGERS[trigger](to), session);
              await keptOut(id, { targetId, url: to, mark, trigger, lag });
            } finally {
              await closeAll([targetId]);
            }
          });
        }
      }
    }
  });
}

for (const [detach, lag] of DETACH)
  test(`C5 and C6 on the guard path, ${detach} detach`, { timeout: 20 * 60 * 1000 }, async (t) => {
    const guard = await guardPage(t, lag);
    sevenPages(guard.seven);
    for (const [name, at] of Object.entries(targets())) {
      const to = at('/doc');
      await t.test(`C5.fulfill.${name} control`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          assert.equal(
            (await guard.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session)).error,
            undefined
          );
          const before = (await guard.events()).length;
          void guard.go(TRIGGERS.href(`${OTHER}/doc?c5`), session);
          let paused = null;
          for (let n = 0; n < 50 && !paused; n += 1) {
            paused = (await guard.events())
              .slice(before)
              .find(
                (e) =>
                  e.method === 'Fetch.requestPaused' && e.params.request.url.includes('/doc?c5')
              );
            if (!paused) await pause(100);
          }
          assert.ok(paused, 'C5 control: the plain document request is paused for the client');
          const body = Buffer.from(
            `<!doctype html><html data-k="C5"><title>AGENT</title></html>`
          ).toString('base64');
          const answer = await guard.send(
            'Fetch.fulfillRequest',
            {
              requestId: paused.params.requestId,
              responseCode: 200,
              responseHeaders: [{ name: 'content-type', value: 'text/html' }],
              body,
            },
            session
          );
          assert.equal(answer.error, undefined);
          assert.equal(
            (await readAttribute(`${OTHER}/doc?c5`)).value,
            'C5',
            'C5 control: the agent’s body renders'
          );
        } finally {
          await closeAll([targetId]);
        }
      });
      await t.test(`C5.fulfill.${name} protected`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          assert.equal(
            (await guard.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session)).error,
            undefined
          );
          const before = (await guard.events()).length;
          const mark = chrome.requests.length;
          await guard.go(TRIGGERS.href(`${to}?c5p`), session);
          await keptOut('C5', { targetId, url: `${to}?c5p`, mark, lag });
          await kept(guard, 'C5', { targetId, session, url: `${to}?c5p`, lag });
          await pause(lag ? lag : 1000);
          const later = (await guard.events()).slice(before);
          assert.ok(
            !later.some(
              (e) =>
                (e.method === 'Fetch.requestPaused' || e.method === 'Fetch.authRequired') &&
                JSON.stringify(e).includes(new URL(to).host)
            ),
            'C5: no paused event for the protected document reached the client'
          );
          for (let n = 1; n <= 40; n += 1) {
            for (const stage of ['0', '1']) {
              const guessed = await guard.send(
                'Fetch.fulfillRequest',
                { requestId: `interception-job-${n}.${stage}`, responseCode: 200, body: '' },
                session
              );
              assert.ok(
                [UNSEEN, PROTECTED].includes(guessed.error?.message),
                `C5: fulfil of interception-job-${n}.${stage} refused (${guessed.error?.message})`
              );
            }
          }
          const shown = await readAttribute(`${to}?c5p`, 'data-k', 1500);
          assert.equal(shown.value, null, 'C5: the agent’s body never replaced the protected one');
        } finally {
          await closeAll([targetId]);
        }
      });

      const origin = name === 'seven' ? SEVEN : VAULT;
      await t.test(`C6.cookies.${name} control`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          await own.send('Storage.setCookies', {
            cookies: [{ name: 'pk', value: '1', url: `${OTHER}/` }],
          });
          const plain = (cookies) =>
            (cookies ?? []).filter((c) => c.name === 'pk' && c.domain === 'plain.test');
          const read = await guard.send('Network.getCookies', { urls: [`${OTHER}/`] }, session);
          assert.equal(
            plain(read.result?.cookies)[0]?.value,
            '1',
            `C6 control: Network.getCookies (${JSON.stringify(read).slice(0, 200)})`
          );
          assert.equal(
            plain((await guard.send('Storage.getCookies')).result?.cookies)[0]?.value,
            '1',
            'C6 control: Storage.getCookies'
          );
          assert.equal(
            plain((await guard.send('Network.getAllCookies', {}, session)).result?.cookies)[0]
              ?.value,
            '1',
            'C6 control: Network.getAllCookies'
          );
          for (const [method, value, at] of [
            ['Network.setCookies', '3', session],
            ['Storage.setCookies', '4', undefined],
          ]) {
            assert.equal(
              (await guard.send(method, { cookies: [{ name: 'pk', value, url: `${OTHER}/` }] }, at))
                .error,
              undefined,
              method
            );
            assert.equal(
              plain((await own.send('Storage.getCookies')).result.cookies)[0]?.value,
              value,
              `C6 control: ${method} changed the plain cookie`
            );
          }
          assert.equal(
            (
              await guard.send(
                'Network.setCookie',
                { name: 'pk', value: '2', url: `${OTHER}/` },
                session
              )
            ).error,
            undefined
          );
          assert.equal(
            plain((await own.send('Storage.getCookies')).result.cookies)[0]?.value,
            '2',
            'C6 control: the plain cookie changed'
          );
          assert.equal(
            (await guard.send('Network.deleteCookies', { name: 'pk', url: `${OTHER}/` }, session))
              .error,
            undefined
          );
          assert.equal(
            plain((await own.send('Storage.getCookies')).result.cookies).length,
            0,
            'C6 control: the plain cookie deleted'
          );
        } finally {
          await closeAll([targetId]);
        }
      });
      await t.test(`C6.cookies.${name} protected`, async () => {
        const targetId = await tab(`${PLAIN}/doc`);
        try {
          const session = await guard.attach(targetId);
          await own.send('Storage.setCookies', {
            cookies: [{ name: 'pk', value: '1', url: `${origin}/` }],
          });
          const host = new URL(origin).hostname;
          const mine = (cookies) =>
            (cookies ?? []).filter((c) => c.name === 'pk' && c.domain.replace(/^\./, '') === host);
          assert.equal(
            mine((await own.send('Storage.getCookies')).result.cookies).length,
            1,
            'C6: pk=1 planted'
          );
          assert.equal(
            (await guard.send('Network.getCookies', { urls: [`${origin}/`] }, session)).error
              ?.message,
            PROTECTED,
            'C6: a read naming only the protected origin is refused'
          );
          for (const [method, params, at] of [
            ['Network.getCookies', { urls: [`${origin}/`, `${PLAIN}/`] }, session],
            ['Network.getAllCookies', {}, session],
            ['Storage.getCookies', {}, undefined],
          ]) {
            const answer = await guard.send(method, params, at);
            assert.ok(
              Array.isArray(answer.result?.cookies),
              `${method} answered (${JSON.stringify(answer).slice(0, 200)})`
            );
            assert.equal(
              mine(answer.result.cookies).length,
              0,
              `C6: ${method} doesn't return the protected cookie`
            );
          }
          for (const [method, params, at] of [
            ['Network.setCookie', { name: 'pk', value: '9', url: `${origin}/` }, session],
            [
              'Network.setCookies',
              { cookies: [{ name: 'pk', value: '9', url: `${origin}/` }] },
              session,
            ],
            [
              'Storage.setCookies',
              { cookies: [{ name: 'pk', value: '9', url: `${origin}/` }] },
              undefined,
            ],
            ['Network.deleteCookies', { name: 'pk', url: `${origin}/` }, session],
          ]) {
            assert.equal((await guard.send(method, params, at)).error?.message, PROTECTED, method);
          }
          const left = mine((await own.send('Storage.getCookies')).result.cookies);
          assert.deepEqual(
            left.map((c) => c.value),
            ['1'],
            'C6: the planted cookie is unchanged'
          );
        } finally {
          await closeAll([targetId]);
        }
      });
    }
  });

const fetchOn = (guard, session, rule) =>
  guard.seven.evaluate(
    ([session, rule]) => {
      const { guarded } = window;
      guarded.seen = [];
      guarded.ids = {};
      for (const handler of guarded.handlers) guarded.handlers.delete(handler);
      guarded.handlers.add((event) => {
        if (event.sessionId !== session) return;
        const { requestId, request = {} } = event.params ?? {};
        const mine = request.url === rule.url;
        if (event.method === 'Fetch.authRequired') {
          if (mine) guarded.seen.push('auth');
          if (mine && rule.holdAuth) return;
          const authChallengeResponse =
            mine && rule.credentials
              ? { response: 'ProvideCredentials', username: 'u', password: 'p' }
              : { response: 'Default' };
          void guarded.send(
            'Fetch.continueWithAuth',
            { requestId, authChallengeResponse },
            session
          );
          return;
        }
        if (event.method !== 'Fetch.requestPaused') return;
        const response =
          event.params.responseStatusCode !== undefined ||
          event.params.responseErrorReason !== undefined;
        guarded.ids[request.url] = requestId;
        if (mine) guarded.seen.push(response ? 'response' : 'request');
        if (mine && !response && rule.fulfil) {
          void guarded.send(
            'Fetch.fulfillRequest',
            {
              requestId,
              responseCode: 200,
              responseHeaders: [
                { name: 'content-type', value: rule.type },
                { name: 'access-control-allow-origin', value: '*' },
              ],
              body: rule.fulfil,
            },
            session
          );
          return;
        }
        if (mine && rule.hold) return;
        void guarded.send(
          response ? 'Fetch.continueResponse' : 'Fetch.continueRequest',
          { requestId },
          session
        );
      });
    },
    [session, rule]
  );
const fetchSeen = (guard) =>
  guard.seven.evaluate(() => ({ seen: window.guarded.seen, ids: window.guarded.ids }));
const value = async (guard, session, expression) =>
  (
    await guard.send(
      'Runtime.evaluate',
      {
        expression: `Promise.race([${expression}, new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000))])`,
        awaitPromise: true,
        returnByValue: true,
      },
      session,
      10000
    )
  ).result?.result?.value;
const KINDS = {
  fetch: {
    path: (at) => (at === SEVEN ? '/probe-data.txt' : '/data'),
    run: (url) => `fetch(${JSON.stringify(url)}).then((r) => r.text(), () => 'error')`,
    fulfilled: 'fulfilled',
    body: () => btoa('fulfilled'),
    type: 'text/plain',
  },
  xhr: {
    path: (at) => (at === SEVEN ? '/probe-data.txt' : '/data'),
    run: (url) =>
      `new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(url)}); x.onload = () => resolve(x.responseText); x.onerror = () => resolve('error'); x.send(); })`,
    fulfilled: 'fulfilled',
    body: () => btoa('fulfilled'),
    type: 'text/plain',
  },
  image: {
    path: (at) => (at === SEVEN ? '/probe-img.svg' : '/img'),
    run: (url) =>
      `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('width ' + i.naturalWidth); i.onerror = () => resolve('error'); i.src = ${JSON.stringify(url)}; })`,
    fulfilled: 'width 2',
    body: () => btoa(SVG(2)),
    type: 'image/svg+xml',
  },
};
const reached = (at, path, tag, mark) =>
  at === SEVEN
    ? chrome.requests.slice(mark).includes(path)
    : heard.some((hit) => hit.path === `${path}?n=${tag}`);

for (const [detach, lag] of DETACH) {
  test(`C5 subresources, auth and guessed ids on the guard path, ${detach} detach`, {
    timeout: 20 * 60 * 1000,
  }, async (t) => {
    const guard = await guardPage(t, lag);
    chrome.overrides.set('/probe-data.txt', 'real-seven');
    chrome.overrides.set('/probe-img.svg', SVG(1));
    const plainTab = async () => {
      const targetId = await tab(`${PLAIN}/doc`);
      t.after(() => closeAll([targetId]));
      return { targetId, session: await guard.attach(targetId) };
    };
    const both = {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' },
      ],
    };
    for (const [kind, k] of Object.entries(KINDS)) {
      const vector = async (id, at) => {
        const { session } = await plainTab();
        assert.equal((await guard.send('Fetch.enable', both, session)).error, undefined);
        const path = k.path(at);
        const url = `${at}${path}?n=${id}`;
        await fetchOn(guard, session, { url, fulfil: k.body(), type: k.type });
        const mark = chrome.requests.length;
        const body = await value(guard, session, k.run(url));
        await guard.send('Fetch.disable', {}, session);
        const { seen } = await fetchSeen(guard);
        return {
          seen: seen.length > 0,
          fulfilled: body === k.fulfilled,
          answered: reached(at, path, id, mark),
          body,
        };
      };
      for (const [name, at] of [
        ['seven', SEVEN],
        ['vault', VAULT],
      ]) {
        const id = `C5.${kind}.${name}`;
        await t.test(`${id} control`, async () => {
          const got = await vector(`${id}:plain`, OTHER);
          assert.deepEqual(
            [got.seen, got.fulfilled, got.answered],
            [true, true, false],
            `${id} control: the client sees and fulfils a plain ${kind} (${got.body})`
          );
        });
        await t.test(`${id} protected`, async () => {
          const got = await vector(`${id}:guard`, at);
          assert.deepEqual(
            [got.seen, got.fulfilled, got.answered],
            [false, false, true],
            `${id}: the protected ${kind} is never shown, not fulfilled, and reaches the real server (${got.body})`
          );
        });
      }
    }

    const authVector = async (id, at) => {
      const url = `${at}/auth/${detach}-${id.replace(/\W/g, '-')}/?n=${id}`;
      const probe = (u) =>
        `fetch(${JSON.stringify(u)}, { credentials: 'include' }).then(async (r) => r.status + ' ' + (await r.text()), () => 'error')`;
      const untouched = await plainTab();
      const plain = await value(guard, untouched.session, probe(`${url}&plain=1`));
      const { session } = await plainTab();
      assert.equal(
        (
          await guard.send(
            'Fetch.enable',
            { patterns: [{ urlPattern: '*' }], handleAuthRequests: true },
            session
          )
        ).error,
        undefined
      );
      await fetchOn(guard, session, { url, credentials: true });
      const body = await value(guard, session, probe(url));
      await guard.send('Fetch.disable', {}, session);
      const { seen } = await fetchSeen(guard);
      return {
        plain,
        body,
        seen: seen.includes('auth'),
        paused: seen.includes('request'),
        authed: body === '200 authed',
        untouched: body === plain,
      };
    };
    for (const [name, at] of [
      ['seven', ABC],
      ['vault', VAULT],
    ]) {
      await t.test(`C5.auth.${name} control`, async () => {
        const got = await authVector(`C5.auth.${name}:plain`, OTHER);
        assert.deepEqual(
          [got.seen, got.paused, got.authed, got.untouched],
          [true, true, true, false],
          `C5.auth control: the client answers a plain challenge (${got.plain} / ${got.body})`
        );
      });
      await t.test(`C5.auth.${name} protected`, async () => {
        const got = await authVector(`C5.auth.${name}:guard`, at);
        assert.deepEqual(
          [got.seen, got.paused, got.authed, got.untouched],
          [false, false, false, true],
          `C5.auth: the protected challenge never reaches the client and the request goes on untouched (${got.plain} / ${got.body})`
        );
      });
    }

    const headers = [
      { name: 'content-type', value: 'text/plain' },
      { name: 'access-control-allow-origin', value: '*' },
    ];
    const COMMANDS = {
      fulfill: [
        'Fetch.fulfillRequest',
        { responseCode: 200, responseHeaders: headers, body: btoa('guessed') },
      ],
      continue: [
        'Fetch.continueRequest',
        { url: `${OTHER}/data?n=rewritten`, headers: [{ name: 'X-Agent', value: 'set-by-agent' }] },
      ],
      response: ['Fetch.continueResponse', { responseCode: 200, responseHeaders: headers }],
      auth: [
        'Fetch.continueWithAuth',
        {
          authChallengeResponse: {
            response: 'ProvideCredentials',
            username: 'user',
            password: 'pass',
          },
        },
      ],
      fail: ['Fetch.failRequest', { errorReason: 'Failed' }],
    };
    const STAGED = {
      response: { requestStage: 'Response' },
      auth: {
        path: (id) => `/auth/g-${detach}-${id.replace(/[^a-z0-9]+/gi, '-')}/`,
        holdAuth: true,
      },
    };
    const guessed = async (id, at, kind, [method, params]) => {
      const staged = STAGED[kind] ?? {};
      const { session } = await plainTab();
      assert.equal(
        (
          await guard.send(
            'Fetch.enable',
            {
              patterns: [{ urlPattern: '*', requestStage: staged.requestStage ?? 'Request' }],
              ...(staged.holdAuth ? { handleAuthRequests: true } : {}),
            },
            session
          )
        ).error,
        undefined
      );
      const path = staged.path ? staged.path(id) : KINDS.fetch.path(at);
      const url = `${at}${path}?n=${id}`;
      await fetchOn(
        guard,
        session,
        staged.holdAuth ? { url, holdAuth: true } : { url, hold: true }
      );
      const before = `${OTHER}/data?n=a-${id}`;
      const after = `${OTHER}/data?n=b-${id}`;
      const mark = chrome.requests.length;
      const seen = heard.length;
      await value(guard, session, KINDS.fetch.run(before));
      const run = staged.holdAuth
        ? `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((r) => r.text(), () => 'error')`
        : KINDS.fetch.run(url);
      await guard.send('Runtime.evaluate', { expression: `window.probe = ${run}; true` }, session);
      await pause(300);
      await value(guard, session, KINDS.fetch.run(after));
      if (staged.holdAuth && at === OTHER) {
        for (let n = 0; n < 30 && !(await fetchSeen(guard)).seen.includes('auth'); n += 1) {
          await pause(100);
        }
      }
      const { ids } = await fetchSeen(guard);
      const num = (requestId) => Number(/(\d+)\.\d+$/.exec(requestId ?? '')?.[1]);
      const [lo, hi] = [num(ids[before]), num(ids[after])];
      const prefix = (ids[before] ?? '').replace(/\d+\.\d+$/, '');
      const suffix = /\.\d+$/.exec(ids[before] ?? '')?.[0] ?? '.0';
      const attempts = [];
      for (let n = lo + 1; n < hi; n += 1) {
        const answer = await guard.send(
          method,
          { ...params, requestId: `${prefix}${n}${suffix}` },
          session
        );
        attempts.push([`${prefix}${n}${suffix}`, answer.error?.message ?? null]);
      }
      const body = await value(guard, session, 'window.probe');
      await guard.send('Fetch.disable', {}, session);
      await pause(300);
      return {
        candidates: attempts.length > 0,
        accepted: attempts.some(
          ([, message]) =>
            message !== UNSEEN && message !== PROTECTED && !/interception ?id/i.test(message ?? '')
        ),
        refused:
          attempts.length > 0 &&
          attempts.every(([, message]) => message === UNSEEN || message === PROTECTED),
        tagged: heard
          .slice(seen)
          .some((hit) => hit.path === '/data?n=rewritten' && hit.agent === 'set-by-agent'),
        answered: reached(at, path, id, mark),
        body,
        attempts,
      };
    };
    const effect = {
      fulfill: (got) => got.body === 'guessed' && !got.answered,
      continue: (got) => got.tagged,
      response: (got) => got.answered && !['timeout', 'error', 'guessed'].includes(got.body),
      auth: (got) => got.body === 'authed',
      fail: (got) => got.body === 'error' && !got.answered,
    };
    for (const [name, at] of [
      ['seven', SEVEN],
      ['vault', VAULT],
    ]) {
      for (const [kind, command] of Object.entries(COMMANDS)) {
        const id = `C5.guessed-id.${kind}.${name}`;
        await t.test(`${id} control`, async () => {
          const got = await guessed(`${id}:plain`, OTHER, kind, command);
          assert.ok(
            got.candidates && got.accepted && effect[kind](got),
            `${id} control: ${command[0]} on a guessed id releases a held plain request of its own, with its effect (${got.body} ${JSON.stringify(got.attempts)})`
          );
        });
        await t.test(`${id} protected`, async () => {
          const got = await guessed(`${id}:guard`, at, kind, command);
          assert.deepEqual(
            [got.candidates, got.refused, got.body === 'guessed', got.tagged, got.answered],
            [true, true, false, false, true],
            `${id}: ${command[0]} on every guessed id is refused and the protected request is answered by its server (${got.body} ${JSON.stringify(got.attempts)})`
          );
        });
      }
    }
  });
}

const SW = {
  '/sw-probe/register.html':
    "<!doctype html><title>registering</title><script>navigator.serviceWorker.register('/sw-probe/sw.js', { scope: '/sw-probe/' }).then(() => navigator.serviceWorker.ready).then(() => { document.title = 'ready'; }, (error) => { document.title = 'failed ' + error.message; });</script>",
  '/sw-probe/sw.js':
    "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim())); self.addEventListener('fetch', (event) => { if (new URL(event.request.url).pathname === '/sw-probe/page') event.respondWith(new Response('<!doctype html><title>served by the worker</title>', { headers: { 'content-type': 'text/html' } })); });",
};

const title = async (prefix, ms) =>
  (await readIn(prefix, 'document.readyState === "complete" ? document.title : null', ms)).value;

for (const [detach, lag] of DETACH) {
  test(`PRE-1b: a tab the client touched never loads seven's or the vault's documents, ${detach} detach`, {
    timeout: 20 * 60 * 1000,
  }, async (t) => {
    const guard = await guardPage(t, lag);
    sevenPages(guard.seven);
    for (const [path, body] of Object.entries(SW)) chrome.overrides.set(path, body);
    let n = 0;
    const tag = (kind) => `${kind}-${detach}-${(n += 1)}`;
    const opened = [];
    t.after(() => closeAll(opened));
    const touched = async (id) => {
      const targetId = await tab(`${PLAIN}/doc?start-${id}`);
      opened.push(targetId);
      const session = await guard.attach(targetId);
      return { targetId, session: await live(id, session) };
    };
    const live = async (id, session) => {
      assert.match(
        (await guard.send('Page.addScriptToEvaluateOnNewDocument', { source: marker(id) }, session))
          .error?.message ?? '',
        SCRIPTS,
        `${id}: scripts for later documents stay refused`
      );
      const next = `${OTHER}/doc?next-${id}`;
      const mark = chrome.requests.length;
      await guard.go(TRIGGERS.href(next), session);
      let title = null;
      for (const end = Date.now() + lag + 15000; title !== 'STAND' && Date.now() < end; ) {
        await pause(200);
        title = (
          await guard.send(
            'Runtime.evaluate',
            { expression: 'document.title', returnByValue: true },
            session
          )
        ).result?.result?.value;
      }
      assert.equal(
        title,
        'STAND',
        `${id}: the client's session follows the tab to the allowed page`
      );
      assert.ok(served(next, mark), `${id}: the allowed page was served, so the probe is live`);
      return session;
    };
    const blocked = async (id, { targetId, session }, url, expression = TRIGGERS.href(url)) => {
      const before = (await guard.events()).length;
      const mark = chrome.requests.length;
      await guard.go(expression, session);
      await keptOut(id, { targetId, url, mark, lag });
      await kept(guard, id, { targetId, session, url, lag });
      await pause(lag);
      const later = (await guard.events()).slice(before);
      const naming = later.filter((event) => JSON.stringify(event).includes(url));
      assert.deepEqual(
        naming.map((event) => event.method),
        [],
        `${id}: nothing naming the protected document reached the client`
      );
    };

    const blankShot = async () => {
      const targetId = await tab('about:blank');
      opened.push(targetId);
      const { sessionId } = (await own.send('Target.attachToTarget', { targetId, flatten: true }))
        .result;
      const shot = (await own.send('Page.captureScreenshot', { format: 'png' }, sessionId)).result
        ?.data;
      await own.send('Target.detachFromTarget', { sessionId });
      return shot;
    };
    await t.test(
      'the page a failed protected document leaves shows nothing of it: frame tree, history, title, text and pixels (#450)',
      async () => {
        const blank = await blankShot();
        assert.ok(blank, 'a blank tab can be shot');
        for (const [how, base] of [
          ['direct', `${VAULT}/doc`],
          ['302', `${VAULT}/doc`],
          ['direct', `${SEVEN}/probe-doc.html`],
          ['302', `${SEVEN}/probe-doc.html`],
        ]) {
          const id = tag(`wiped-${how}`);
          const url = `${base}?secret-${id}#frag-${id}`;
          const page = await touched(id);
          assert.equal(
            (await guard.send('Target.setDiscoverTargets', { discover: true })).error,
            undefined
          );
          const before = (await guard.events()).length;
          const observer = await harness(page.targetId);
          await guard.go(how === 'direct' ? TRIGGERS.href(url) : TRIGGERS[302](url), page.session);
          await keptOut(id, {
            targetId: page.targetId,
            url: url.split('#')[0],
            mark: chrome.requests.length,
            lag,
          });
          const wait = lag + 6000;
          const deadline = Date.now() + wait;
          let timer;
          let blanked;
          try {
            blanked = await Promise.race([
              (async () => {
                while (Date.now() < deadline) {
                  const tree = await observer.send('Page.getFrameTree');
                  if (Date.now() < deadline && tree.result?.frameTree?.frame.url === BLANKED)
                    return true;
                  await pause(100);
                }
                return false;
              })(),
              new Promise((resolve) => {
                timer = setTimeout(resolve, wait, false);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          assert.equal(
            blanked,
            true,
            `${id}: the private blank arrived before scrub expiry plus margin`
          );
          const read = async (method, params = {}) =>
            JSON.stringify(await guard.send(method, params, page.session));
          const seen = {
            tree: await read('Page.getFrameTree'),
            history: await read('Page.getNavigationHistory'),
            page: await read('Runtime.evaluate', {
              expression:
                'JSON.stringify([document.title, document.body?.innerText ?? "", window.loadTimeData?.data_ ?? null, location.href])',
              returnByValue: true,
            }),
            info: await read('Target.getTargetInfo', { targetId: page.targetId }),
            targets: await read('Target.getTargets'),
          };
          await guard.send('Target.setDiscoverTargets', { discover: false });
          const asked = `${PLAIN}/redirect?to=${encodeURIComponent(url)}`;
          const scrubbedAsked =
            how === '302' ? redacting(protection(SEVEN))({ url: asked }).params.url : asked;
          seen.events = JSON.stringify((await guard.events()).slice(before))
            .replaceAll(asked, 'the client’s own request')
            .replaceAll(scrubbedAsked, 'the client’s own request');
          const host = new URL(base).host;
          for (const [what, text] of Object.entries(seen)) {
            assert.ok(
              !text.includes(`secret-${id}`) &&
                !text.includes(`frag-${id}`) &&
                !text.includes(host),
              `${id}: ${what} shows nothing of the failed document (${text.slice(0, 400)})`
            );
          }
          const { result: history } = await guard.send(
            'Page.getNavigationHistory',
            {},
            page.session
          );
          const failed = history.entries.find(
            (entry) => entry.url === 'chrome-error://chromewebdata/'
          );
          assert.ok(failed, `${id}: the failed entry is listed as the error page`);
          assert.equal(
            (await guard.send('Page.navigateToHistoryEntry', { entryId: failed.id }, page.session))
              .error?.message,
            PROTECTED,
            `${id}: the client can't go back to the failed entry`
          );
          const shot = await guard.send('Page.captureScreenshot', { format: 'png' }, page.session);
          assert.equal(
            shot.result?.data,
            blank,
            `${id}: the tab shows a blank page, not Chrome's error page naming the protected host`
          );
        }
      }
    );
    await t.test(
      'an unflattened attach is refused as unflattened on an ordinary tab, and as protected on the vault',
      async () => {
        const plain = await tab(`${PLAIN}/doc?unflat-${tag('unflat')}`);
        const vault = await tab(`${VAULT}/doc?unflat-${tag('unflat')}`);
        opened.push(plain, vault);
        for (const params of [{ targetId: plain }, { targetId: plain, flatten: false }]) {
          assert.equal(
            (await guard.send('Target.attachToTarget', params)).error?.message,
            UNFLAT,
            JSON.stringify(params)
          );
        }
        assert.equal(
          (await guard.send('Target.attachToTarget', { targetId: vault })).error?.message,
          PROTECTED
        );
        assert.equal(
          (await guard.send('Target.attachToTarget', { targetId: plain, flatten: true })).error,
          undefined,
          'the same tab attaches once flattened'
        );
      }
    );
    await t.test(
      'a tab the guard cannot arm, because arming fails or never answers, is refused (UNGUARDED)',
      async () => {
        for (const how of ['fail', 'drop']) {
          const targetId = await tab(`${PLAIN}/doc?unarmed-${tag(how)}`);
          opened.push(targetId);
          const before = (await guard.events()).length;
          guard.stall(how);
          const answer = await guard.send(
            'Target.attachToTarget',
            { targetId, flatten: true },
            undefined,
            20000
          );
          assert.equal(answer.error?.message, UNGUARDED, `${how}: ${JSON.stringify(answer)}`);
          assert.ok(
            !(await guard.events())
              .slice(before)
              .some((event) => event.method === 'Target.attachedToTarget'),
            `${how}: the client never got a session`
          );
        }
      }
    );
    await t.test('a protected page restored without a request still cuts the client', async () => {
      const id = tag('bfcache');
      const vault = `${VAULT}/doc?${id}`;
      const targetId = await tab(vault);
      opened.push(targetId);
      const raw = (await own.send('Target.attachToTarget', { targetId, flatten: true })).result
        .sessionId;
      await own.send('Page.navigate', { url: `${PLAIN}/doc?after-${id}` }, raw);
      await pause(1500);
      await own.send('Target.detachFromTarget', { sessionId: raw });
      const session = await guard.attach(targetId);
      const before = (await guard.events()).length;
      const requested = heard.length;
      await guard.go('history.back()', session);
      assert.ok(await loaded(vault, lag + 8000), 'the vault page came back from the cache');
      assert.ok(
        !heard.slice(requested).some((hit) => hit.host === new URL(VAULT).host),
        'without a request, so the guard could not fail it'
      );
      let answer = null;
      for (let n = 0; n < 50 && answer?.error?.message !== PROTECTED; n += 1) {
        answer = await guard.send('Runtime.evaluate', { expression: 'document.title' }, session);
        if (answer.error?.message !== PROTECTED) await pause(200);
      }
      assert.equal(answer.error?.message, PROTECTED, 'the client’s session on it is cut');
      assert.ok(
        !JSON.stringify((await guard.events()).slice(before)).includes(new URL(VAULT).host),
        'nothing naming the vault reached the client'
      );
    });
    await t.test('an untouched tab still loads both protected origins', async () => {
      for (const url of [
        `${SEVEN}/probe-doc.html?${tag('untouched')}`,
        `${VAULT}/doc?${tag('untouched')}`,
      ]) {
        opened.push(await tab(url));
        assert.ok(await loaded(url, 15000), `a tab the client never touched loads ${url}`);
      }
    });
    await t.test('an init script, then a script navigation onto seven', async () => {
      const id = tag('script');
      await blocked(id, await touched(id), `${SEVEN}/probe-doc.html?${id}`);
    });
    await t.test('an init script, then a script navigation onto the vault', async () => {
      const id = tag('vault');
      await blocked(id, await touched(id), `${VAULT}/doc?${id}`);
    });
    await t.test('a server redirect into a protected origin', async () => {
      for (const base of [`${SEVEN}/probe-doc.html`, `${VAULT}/doc`]) {
        const id = tag('redirect');
        const url = `${base}?${id}`;
        await blocked(id, await touched(id), url, TRIGGERS[302](url));
      }
    });
    await t.test(
      'a tab the client creates straight onto a redirect into the vault never loads it',
      async () => {
        for (const base of [`${SEVEN}/probe-doc.html`, `${VAULT}/doc`]) {
          const id = tag('created');
          const url = `${base}?${id}`;
          const before = (await guard.events()).length;
          const mark = chrome.requests.length;
          const created = await guard.send('Target.createTarget', {
            url: `${PLAIN}/redirect?to=${encodeURIComponent(url)}`,
          });
          const targetId = created.result?.targetId;
          assert.ok(targetId, `${id}: the tab was created (${JSON.stringify(created)})`);
          opened.push(targetId);
          await keptOut(id, { targetId, url, mark, lag });
          const session = await guard.attach(targetId);
          await kept(guard, id, { targetId, session, url, lag });
          assert.ok(
            !JSON.stringify((await guard.events()).slice(before)).includes(url),
            `${id}: nothing naming the protected document reached the client`
          );
        }
      }
    );
    await t.test(
      'a script navigation onto the vault with a fragment keeps the session too',
      async () => {
        const id = tag('fragment');
        await blocked(id, await touched(id), `${VAULT}/doc?${id}#section`);
      }
    );
    const popupOf = async (openerId, ms) => {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const { result } = await own.send('Target.getTargets');
        const found = (result?.targetInfos ?? []).find(
          (info) =>
            info.type === 'page' && info.openerId === openerId && !opened.includes(info.targetId)
        );
        if (found) {
          opened.push(found.targetId);
          return found;
        }
        await pause(200);
      }
      return null;
    };
    await t.test(
      'a popup the client attaches to is touched; a protected popup gets no client session, script or event',
      async () => {
        const id = tag('popup');
        const opener = await touched(id);
        const popupURL = `${OTHER}/doc?popup-${id}`;
        await guard.go(TRIGGERS.popup(popupURL), opener.session);
        const popup = await popupOf(opener.targetId, lag + 15000);
        assert.ok(popup, 'the allowed popup opened');
        assert.ok(await loaded(popupURL, lag + 15000), 'the allowed popup loaded');
        const session = await live(`${id}-opened`, await guard.attach(popup.targetId));
        await blocked(
          id,
          { targetId: popup.targetId, session },
          `${SEVEN}/probe-doc.html?popup-${id}`
        );

        const direct = `${VAULT}/doc?direct-${id}`;
        const before = (await guard.events()).length;
        await guard.go(TRIGGERS.popup(direct), opener.session);
        const vaultPopup = await popupOf(opener.targetId, lag + 15000);
        assert.ok(vaultPopup, 'the vault popup opened');
        await pause(2000);
        const refused = await guard.send('Target.attachToTarget', {
          targetId: vaultPopup.targetId,
          flatten: true,
        });
        assert.equal(
          refused.error?.message,
          PROTECTED,
          'the client can’t attach to the vault popup'
        );
        await pause(lag + 2000);
        const later = (await guard.events()).slice(before);
        assert.deepEqual(
          later.filter((event) => event.method === 'Target.attachedToTarget'),
          [],
          'no attachedToTarget for the vault popup'
        );
        assert.ok(
          !JSON.stringify(later).includes(direct),
          'nothing naming the vault popup’s document reached the client'
        );
        assert.ok(
          !beacons.some((b) => b.id === id && b.host === new URL(VAULT).host),
          'no client script ran in the vault popup'
        );
      }
    );
    await t.test(
      'iframes: an allowed cross-site one is shown, a vault one is never loaded',
      async () => {
        const id = tag('frame');
        const page = await touched(id);
        assert.equal(
          (
            await guard.send(
              'Target.setAutoAttach',
              { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
              page.session
            )
          ).error,
          undefined
        );
        try {
          const before = (await guard.events()).length;
          const cross = `${PLAIN}/doc?frame-${id}`;
          await guard.go(TRIGGERS.iframe(cross), page.session);
          let crossAttached = null;
          for (const end = Date.now() + lag + 15000; !crossAttached && Date.now() < end; ) {
            await pause(200);
            crossAttached = (await guard.events())
              .slice(before)
              .find(
                (event) =>
                  event.method === 'Target.attachedToTarget' &&
                  event.params.targetInfo.url.startsWith(cross)
              );
          }
          assert.equal(crossAttached?.params.targetInfo.type, 'iframe');
          assert.ok(await loaded(cross, lag + 15000), 'the allowed cross-site iframe loaded');
          const child = crossAttached.params.sessionId;
          await guard.send(
            'Runtime.evaluate',
            {
              expression: `document.documentElement.setAttribute('data-k', ${JSON.stringify(id)})`,
            },
            child
          );
          assert.equal(
            (await readAttribute(cross, 'data-k', lag + 15000)).value,
            id,
            'the client drives the allowed cross-site iframe through its own session'
          );
          assert.equal(crossAttached?.params.waitingForDebugger, false);
          const vault = `${VAULT}/doc?frame-${id}`;
          const later = (await guard.events()).length;
          const mark = chrome.requests.length;
          await guard.go(TRIGGERS.iframe(vault), page.session);
          await pause(lag + 4000);
          assert.equal(
            served(vault, mark),
            false,
            'the vault iframe was never requested from the touched tab'
          );
          assert.ok(
            !(await guard.events())
              .slice(later)
              .some(
                (event) =>
                  event.method === 'Target.attachedToTarget' &&
                  JSON.stringify(event).includes('vault')
              ),
            'the client never got the vault iframe'
          );
          assert.ok(
            !beacons.some((b) => b.id === id && b.host === new URL(VAULT).host),
            'no client script ran in the vault iframe'
          );
        } finally {
          await guard.send(
            'Target.setAutoAttach',
            { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
            page.session
          );
        }
      }
    );
    await t.test('a popup that never gets a URL is never shown', async () => {
      const id = tag('hang');
      const opener = await touched(id);
      const before = (await guard.events()).length;
      await guard.go(TRIGGERS.popup(`${PLAIN}/hang?${id}`), opener.session);
      const popup = await popupOf(opener.targetId, 5000);
      assert.ok(popup, 'the popup exists, found through the harness’s own CDP');
      await pause(12000);
      assert.ok(
        !(await guard.events())
          .slice(before)
          .some(
            (event) =>
              event.method === 'Target.attachedToTarget' &&
              event.params.targetInfo.targetId === popup.targetId
          ),
        'the client never got a session to a popup without a URL'
      );
    });
    await t.test(
      'a canary in a protected page’s localStorage, IndexedDB and cookies is out of reach of a guarded session',
      async () => {
        const canary = tag('canary');
        const plant = (value) => `(async () => {
          localStorage.setItem('canary', '${value}');
          document.cookie = 'canary=${value}; path=/';
          await new Promise((resolve, reject) => {
            const open = indexedDB.open('${value}', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('store');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction('store', 'readwrite');
              tx.objectStore('store').put('${value}', 'key');
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            };
          });
          return 'planted';
        })()`;
        const sites = {
          plain: [OTHER, `${OTHER}/doc?${canary}`],
          seven: [SEVEN, `${SEVEN}/probe-doc.html?${canary}`],
          vault: [VAULT, `${VAULT}/doc?${canary}`],
        };
        for (const [name, [origin, page]] of Object.entries(sites)) {
          const targetId = await tab(page);
          opened.push(targetId);
          const { send } = await harness(targetId);
          const planted = await send('Runtime.evaluate', {
            expression: plant(`${canary}-${name}`),
            awaitPromise: true,
            returnByValue: true,
          });
          assert.equal(
            planted.result?.result?.value,
            'planted',
            `the canary is planted on ${origin}`
          );
        }
        const reader = await touched(tag('canary-reader'));
        const from = (await guard.events()).length;
        const site = (origin) => Object.entries(sites).find(([, [at]]) => at === origin)[0];
        const reads = (origin) => [
          ['DOMStorage.enable', {}],
          [
            'DOMStorage.getDOMStorageItems',
            { storageId: { securityOrigin: origin, isLocalStorage: true } },
          ],
          ['IndexedDB.enable', {}],
          ['IndexedDB.requestDatabaseNames', { securityOrigin: origin }],
          [
            'IndexedDB.requestDatabase',
            { securityOrigin: origin, databaseName: `${canary}-${site(origin)}` },
          ],
          ['Network.getCookies', { urls: [`${origin}/`] }],
          ['Network.getAllCookies', {}],
          ['Storage.getCookies', {}],
        ];
        const read = (method, params) =>
          guard.send(method, params, method.startsWith('Storage.') ? undefined : reader.session);
        const live = [];
        for (const [method, params] of reads(OTHER)) {
          if (JSON.stringify(await read(method, params)).includes(`${canary}-plain`))
            live.push(method);
        }
        for (const method of [
          'DOMStorage.getDOMStorageItems',
          'IndexedDB.requestDatabaseNames',
          'Network.getCookies',
        ]) {
          assert.ok(
            live.includes(method),
            `the plain canary is readable through ${method}, so the probe is live (${live})`
          );
        }
        for (const [origin] of [sites.plain, sites.seven, sites.vault]) {
          for (const [method, params] of reads(origin)) {
            const text = JSON.stringify(await read(method, params));
            for (const name of ['seven', 'vault']) {
              assert.ok(
                !text.includes(`${canary}-${name}`),
                `${method} for ${origin} returned no ${name} canary`
              );
            }
          }
        }
        const later = JSON.stringify((await guard.events()).slice(from));
        for (const name of ['seven', 'vault']) {
          assert.ok(!later.includes(`${canary}-${name}`), `no event carried the ${name} canary`);
        }
      }
    );
    await t.test("a service worker can't serve a touched tab", async () => {
      const register = `${SEVEN}/sw-probe/register.html?${tag('sw')}`;
      opened.push(await tab(register));
      assert.equal(await title(register, 15000), 'ready', 'the probe service worker registered');
      const control = `${SEVEN}/sw-probe/page?${tag('sw-control')}`;
      opened.push(await tab(control));
      assert.equal(
        await title(control, 15000),
        'served by the worker',
        'the worker serves an untouched tab'
      );
      const id = tag('sw');
      await blocked(id, await touched(id), `${SEVEN}/sw-probe/page?${id}`);
    });
    await t.test(
      "the client's own Fetch and Network see its allowed navigation and nothing of the protected one",
      async () => {
        const id = tag('fetch');
        const targetId = await tab(`${PLAIN}/doc?start-${id}`);
        opened.push(targetId);
        const session = await guard.attach(targetId);
        assert.equal((await guard.send('Network.enable', {}, session)).error, undefined);
        assert.equal(
          (
            await guard.send(
              'Fetch.enable',
              {
                patterns: [
                  { urlPattern: '*', requestStage: 'Request' },
                  { urlPattern: '*', requestStage: 'Response' },
                ],
              },
              session
            )
          ).error,
          undefined
        );
        await guard.seven.evaluate((session) => {
          const { guarded } = window;
          for (const handler of guarded.handlers) guarded.handlers.delete(handler);
          guarded.handlers.add((event) => {
            if (event.sessionId !== session || event.method !== 'Fetch.requestPaused') return;
            const response =
              event.params.responseStatusCode !== undefined ||
              event.params.responseErrorReason !== undefined;
            void guarded.send(
              response ? 'Fetch.continueResponse' : 'Fetch.continueRequest',
              { requestId: event.params.requestId },
              session
            );
          });
        }, session);
        try {
          const before = (await guard.events()).length;
          const next = `${OTHER}/doc?own-${id}`;
          await guard.go(TRIGGERS.href(next), session);
          assert.ok(
            await loaded(next, lag + 15000),
            'the allowed navigation loads under the client’s own Fetch'
          );
          const seen = (await guard.events()).slice(before);
          const paused = seen.filter(
            (event) =>
              event.method === 'Fetch.requestPaused' &&
              event.params.request.url === next &&
              event.params.resourceType === 'Document'
          );
          assert.ok(
            paused.some((event) => event.params.responseStatusCode === undefined),
            'its request stage'
          );
          assert.ok(
            paused.some((event) => event.params.responseStatusCode !== undefined),
            'its response stage'
          );
          assert.ok(
            seen.some(
              (event) =>
                event.method === 'Network.requestWillBeSent' && event.params.request.url === next
            ),
            'its Network event'
          );
          const pixel = `/pixel?own-${id}`;
          for (const end = Date.now() + lag + 15000; ; await pause(100)) {
            const answered = (await guard.events())
              .slice(before)
              .some(
                (event) =>
                  event.method === 'Network.responseReceived' &&
                  event.params.response.url.endsWith(pixel)
              );
            if (answered) break;
            assert.ok(
              Date.now() < end,
              'the allowed page’s own pixel answers under the client’s Network'
            );
          }
          const url = `${SEVEN}/probe-doc.html?${id}`;
          const mark = (await guard.events()).length;
          const requests = chrome.requests.length;
          await guard.go(TRIGGERS.href(url), session);
          await keptOut(id, { targetId, url, mark: requests, lag });
          assert.ok(
            !JSON.stringify((await guard.events()).slice(mark)).includes(id),
            'the client’s Fetch and Network never saw the protected request'
          );
        } finally {
          await instrumentOn(guard, null);
        }
      }
    );
    await t.test('the guard still answers', async () => {
      assert.equal((await guard.send('Browser.getVersion')).error, undefined);
    });
  });
}

once(
  'PRE-1b on the link path, which forwards browser-level events: a popup the client auto-attaches is armed before it runs, so the client never holds a session to it while it loads a protected page, even when the guard is slow to arm',
  {
    timeout: 10 * 60 * 1000,
  },
  async (t) => {
    const guard = await guardPage(t, 0, 'link');
    const opened = [];
    t.after(() => closeAll(opened));
    for (let round = 0; round < 3; round += 1) {
      const id = `armed-${round}-${Date.now()}`;
      const opener = await tab(`${PLAIN}/doc?opener-${id}`);
      opened.push(opener);
      const session = await guard.attach(opener);
      const auto = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
      assert.equal((await guard.send('Target.setAutoAttach', auto)).error, undefined);
      try {
        const before = (await guard.events()).length;
        const vault = `${VAULT}/doc?${id}`;
        await guard.slowArm(6000);
        await guard.go(
          TRIGGERS.popup(`${OTHER}/bounce?ms=1000&to=${encodeURIComponent(vault)}`),
          session
        );
        let popup = null;
        for (const end = Date.now() + 8000; !popup && Date.now() < end; ) {
          const { result } = await own.send('Target.getTargets');
          popup = (result?.targetInfos ?? []).find(
            (info) => info.type === 'page' && info.openerId === opener
          );
          if (!popup) await pause(200);
        }
        assert.ok(popup, `${id}: the popup opened, found through the harness’s own CDP`);
        opened.push(popup.targetId);
        await pause(9000);
        const later = (await guard.events()).slice(before);
        const shown = later.some(
          (event) =>
            event.method === 'Target.attachedToTarget' &&
            event.params.targetInfo.targetId === popup.targetId
        );
        const servedVault = served(vault, 0);
        assert.ok(
          !(shown && servedVault),
          `${id}: the client got a session to the popup, and its navigation into the vault was still served`
        );
        if (!shown) {
          assert.ok(
            !JSON.stringify(later).includes(`${new URL(VAULT).host}/doc?${id}`),
            `${id}: the client never got the popup, and nothing naming its vault document`
          );
        }
      } finally {
        await guard.send('Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      }
    }
  }
);

once(
  'privileged browser pages through the guard: a browser_ui target that reports a web URL stays out of reach, and a new tab with its chrome-untrusted frame is attached and driven',
  {
    timeout: 5 * 60 * 1000,
  },
  async (t) => {
    const listed = (await own.send('Target.getTargets')).result.targetInfos;
    const ui = listed.filter((info) => info.type === 'browser_ui').map((info) => info.targetId);
    assert.ok(
      ui.length > 0,
      `Chrome lists a browser_ui target: ${JSON.stringify(listed.map((info) => info.type))}`
    );
    const NTP_FRAME = 'chrome-untrusted://new-tab-page/one-google-bar?paramsencoded=';
    const newTabs = new Map();
    const web = (info) => {
      if (info?.type === 'browser_ui') return { ...info, url: `${PLAIN}/doc?browser-ui` };
      if (newTabs.has(info?.targetId) && info.url === 'about:blank')
        return { ...info, url: newTabs.get(info.targetId) };
      return info;
    };
    const lens = (message, method) => {
      const result = message.result;
      if (result?.targetInfos) result.targetInfos = result.targetInfos.map(web);
      if (result?.targetInfo) result.targetInfo = web(result.targetInfo);
      if (message.params?.targetInfo) message.params.targetInfo = web(message.params.targetInfo);
      const top = result?.frameTree?.frame;
      const framed = (tree) => [tree, ...(tree?.childFrames ?? []).flatMap(framed)];
      if (
        method === 'Page.getFrameTree' &&
        newTabs.has(top?.id) &&
        !framed(result.frameTree).some((tree) => tree?.frame?.url === NTP_FRAME)
      ) {
        if (top.url === 'about:blank') top.url = newTabs.get(top.id);
        result.frameTree.childFrames = [
          ...(result.frameTree.childFrames ?? []),
          {
            frame: {
              id: `${top.id}-bar`,
              parentId: top.id,
              loaderId: top.loaderId,
              url: NTP_FRAME,
              securityOrigin: 'chrome-untrusted://new-tab-page',
              mimeType: 'text/html',
            },
          },
        ];
      }
      return message;
    };
    const guard = await guardPage(t, 0, null, lens);
    const shown = (await guard.send('Target.getTargets')).result.targetInfos;
    assert.deepEqual(
      shown.filter((info) => ui.includes(info.targetId)),
      [],
      'the guard lists no browser_ui target, though the lens gave each a web URL'
    );
    for (const targetId of ui) {
      for (const method of ['Target.attachToTarget', 'Target.getTargetInfo']) {
        assert.equal(
          (await guard.send(method, { targetId, flatten: true })).error?.message,
          PROTECTED,
          `${method} on browser_ui ${targetId}`
        );
      }
    }
    const opened = [];
    try {
      for (const url of ['chrome://newtab/', 'chrome://new-tab-page/']) {
        const { result } = await own.send('Target.createTarget', { url });
        opened.push(result.targetId);
        newTabs.set(result.targetId, url);
        let seen = '';
        for (let n = 0; n < 100 && !seen.startsWith('chrome://'); n += 1) {
          seen = (await own.send('Target.getTargetInfo', { targetId: result.targetId })).result
            ?.targetInfo?.url;
          seen ??= '';
          if (!seen.startsWith('chrome://')) await pause(100);
        }
        assert.match(
          seen,
          /^chrome:\/\//,
          `${url}: the new tab committed a chrome:// page; last seen ${seen}`
        );
        const answer = await guard.send('Target.attachToTarget', {
          targetId: result.targetId,
          flatten: true,
        });
        assert.equal(
          answer.error,
          undefined,
          `${url}: the client attaches to the new tab: ${JSON.stringify(answer.error)}`
        );
        const sessionId = answer.result.sessionId;
        const tree = await guard.send('Page.getFrameTree', {}, sessionId);
        assert.ok(
          (tree.result?.frameTree?.childFrames ?? []).some(
            (child) => child.frame.url === NTP_FRAME
          ),
          `${url}: the tab holds the chrome-untrusted frame: ${JSON.stringify(tree)}`
        );
        const target = `${PLAIN}/doc?ntp=${encodeURIComponent(url)}`;
        const navigated = await guard.send('Page.navigate', { url: target }, sessionId);
        assert.equal(
          navigated.error,
          undefined,
          `${url}: Page.navigate goes through: ${JSON.stringify(navigated.error)}`
        );
        let now = '';
        for (let n = 0; n < 50 && now !== target; n += 1) {
          now = (await own.send('Target.getTargetInfo', { targetId: result.targetId })).result
            ?.targetInfo?.url;
          if (now !== target) await pause(100);
        }
        assert.equal(now, target, `${url}: the same tab reached the plain page`);
      }
    } finally {
      await closeAll(opened);
    }
  }
);

test('a console message and an exception from code with a relative sourceURL reach the client through the guard', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const guard = await guardPage(t, 0);
  const targetId = await tab(`${PLAIN}/doc?relative-source`);
  t.after(() => closeAll([targetId]));
  const session = await guard.attach(targetId);
  await guard.go("console.log('relative-' + (40 + 2))\n//# sourceURL=foo.js", session);
  await guard.go(
    "setTimeout(() => { throw new Error('thrown-' + (40 + 3)); })\n//# sourceURL=bar.js",
    session
  );
  const deadline = Date.now() + 15000;
  let seen = [];
  for (;;) {
    seen = (await guard.events()).filter((event) => event.sessionId === session);
    const logged = seen.some(
      (event) =>
        event.method === 'Runtime.consoleAPICalled' &&
        event.params.args?.[0]?.value === 'relative-42'
    );
    const thrown = seen.some(
      (event) =>
        event.method === 'Runtime.exceptionThrown' &&
        /thrown-43/.test(event.params.exceptionDetails?.exception?.description ?? '')
    );
    if (logged && thrown) break;
    if (Date.now() > deadline)
      throw new Error(
        `the guard held back events from relative-sourceURL code: ${JSON.stringify(seen.map((event) => event.method))}`
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

for (const route of ['extension', 'link']) {
  once(
    `the ${route} route wipes in place to the blocked data page without publishing the wipe, refuses protected reads before and after, and keeps the same tab drivable`,
    {
      timeout: 5 * 60 * 1000,
    },
    async (t) => {
      const guard = await guardPage(t, 0, route === 'link' ? 'link' : null);
      sevenPages(guard.seven);
      const targetId = await tab(`${PLAIN}/doc?wipe=${route}`);
      const protectedId = await tab(`${VAULT}/vault?read=${route}`);
      t.after(() => closeAll([targetId, protectedId]));
      const attached = await guard.send('Target.attachToTarget', { targetId, flatten: true });
      assert.equal(attached.error, undefined, JSON.stringify(attached));
      const session = attached.result.sessionId;
      const read = async () => {
        const answer = await guard.send(
          'Runtime.evaluate',
          {
            expression:
              '({ href: location.href, title: document.title, origin, body: document.body?.textContent ?? null })',
            returnByValue: true,
          },
          session
        );
        assert.equal(answer.error, undefined, JSON.stringify(answer));
        assert.equal(answer.result?.exceptionDetails, undefined, JSON.stringify(answer));
        return answer.result?.result?.value;
      };
      assert.equal((await read()).title, 'STAND');
      const refused = async () => {
        for (const [method, params, where] of [
          ['Target.attachToTarget', { targetId: protectedId, flatten: true }],
          ['Target.getTargetInfo', { targetId: protectedId }],
          [
            'Page.createIsolatedWorld',
            { frameId: protectedId, worldName: 'protected-read' },
            session,
          ],
          [
            'Page.getResourceContent',
            { frameId: protectedId, url: `${VAULT}/vault?read=${route}` },
            session,
          ],
        ]) {
          assert.equal((await guard.send(method, params, where)).error?.message, PROTECTED, method);
        }
      };
      await refused();
      const owner = await harness(targetId);
      const before = await guard.seven.evaluate(() => window.guarded.messages.length);
      const destination = `${SEVEN}/probe-doc.html?wipe=${route}`;
      const requested = chrome.requests.length;
      await owner.send('Runtime.evaluate', { expression: TRIGGERS.href(destination) });
      let snapshot;
      for (const end = Date.now() + 15000; ; ) {
        snapshot = (
          await owner.send('Runtime.evaluate', {
            expression:
              '({ href: location.href, title: document.title, origin, body: document.body?.textContent ?? null })',
            returnByValue: true,
          })
        ).result?.result?.value;
        if (snapshot?.href === BLANKED && snapshot?.title === 'blocked' && snapshot?.body === '')
          break;
        if (Date.now() > end)
          assert.fail(
            `${route}: the same tab never reached the sentinel: ${JSON.stringify(snapshot)}`
          );
        await pause(100);
      }
      assert.deepEqual(snapshot, { href: BLANKED, title: 'blocked', origin: 'null', body: '' });
      assert.deepEqual(
        await guard.seven.evaluate((before) => window.guarded.messages.slice(before), before),
        [],
        'the private wipe publishes neither replies nor events to the client'
      );
      assert.equal(served(destination, requested), false);
      assert.deepEqual(await read(), snapshot);
      assert.equal(
        (await guard.send('Target.getTargetInfo', { targetId })).result?.targetInfo?.url,
        BLANKED
      );
      const tree = await guard.send('Page.getFrameTree', {}, session);
      assert.equal(tree.error, undefined, JSON.stringify(tree));
      assert.equal(tree.result?.frameTree?.frame.url, BLANKED);
      assert.ok(!tree.result?.frameTree?.frame.unreachableUrl, JSON.stringify(tree));
      await refused();
      const after = `data:text/html,%3Ctitle%3Eafter-wipe-${route}%3C%2Ftitle%3E`;
      const navigated = await guard.send('Page.navigate', { url: after }, session);
      assert.equal(navigated.error, undefined, JSON.stringify(navigated));
      assert.equal(navigated.result?.errorText, undefined, JSON.stringify(navigated));
      for (const end = Date.now() + 15000; ; ) {
        snapshot = await read();
        if (
          snapshot?.href === after &&
          snapshot?.title === `after-wipe-${route}` &&
          snapshot?.body === ''
        )
          break;
        if (Date.now() > end)
          assert.fail(
            `${route}: the kept session could not navigate and read: ${JSON.stringify(snapshot)}`
          );
        await pause(100);
      }
      assert.equal((await guard.send('Page.enable', {}, session)).error, undefined);
      const reloading = (await guard.events()).length;
      assert.equal((await guard.send('Page.reload', {}, session)).error, undefined);
      for (const end = Date.now() + 15000; ; ) {
        if (
          (await guard.events())
            .slice(reloading)
            .some(
              (event) =>
                event.sessionId === session &&
                event.method === 'Page.frameStoppedLoading' &&
                event.params.frameId === targetId
            )
        )
          break;
        if (Date.now() > end) assert.fail(`${route}: the same session did not finish reloading`);
        await pause(100);
      }
      assert.equal((await read()).title, `after-wipe-${route}`);
      assert.equal(
        (await guard.send('Target.getTargetInfo', { targetId })).result?.targetInfo?.targetId,
        targetId
      );
      assert.equal((await guard.send('Target.closeTarget', { targetId })).result?.success, true);
      for (const end = Date.now() + 15000; ; ) {
        const listed = await own.send('Target.getTargets');
        const infos = listed.result?.targetInfos;
        if (infos && !infos.some((info) => info.targetId === targetId)) break;
        if (Date.now() > end)
          assert.fail(
            `${route}: 15 s after closing ${targetId}, the harness's target list was ${JSON.stringify(listed)}`
          );
        await pause(100);
      }
    }
  );
}
