import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const LAG = 8000;
const DETACH = [
  ['prompt', 0],
  ['lagging', LAG],
];
const SCRIPTS = /^scripts and bindings for later documents could run in seven’s pages or the vault/;
const SETTINGS =
  /^settings for a whole session \(headers, user agent, locale, time zone, cache, network conditions, blocked URLs\)/;
const DEBUGGER = /^breakpoints could run in seven’s pages or the vault/;
const PROTECTED = 'seven’s own pages and the vault are out of reach of browser automation';
const UNSEEN = 'this request wasn’t seen, so it could be seven’s or the vault’s';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const beacons = [];
const heard = [];
const page = (body, head = '') =>
  `<!doctype html><html><head>${head}<title>STAND</title></head><body>${body}<script>console.log('STAND-CONSOLE ' + location.host);document.documentElement.setAttribute('data-locale', Intl.DateTimeFormat().resolvedOptions().locale);document.documentElement.setAttribute('data-tz', Intl.DateTimeFormat().resolvedOptions().timeZone);new Image().src = 'http://localhost:${standPort}/pixel' + location.search;</script></body></html>`;
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
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: url.searchParams.get('to') });
    return res.end();
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

const chrome = await launch({
  args: [
    `--remote-debugging-port=${port}`,
    '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1, MAP plain.test 127.0.0.1',
  ],
});
const SEVEN = new URL(chrome.url).origin;
after(() => {
  chrome.close();
  stand.close();
});
const browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
  .webSocketDebuggerUrl;

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
  const send = async (method, params = {}, sessionId) => {
    await ready;
    next += 1;
    const id = next;
    return new Promise((resolve) => {
      pending.set(id, resolve);
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

async function readAttribute(prefix, name = 'data-k', ms = 4000) {
  const deadline = Date.now() + ms;
  let last = { found: false, value: null };
  while (Date.now() < deadline) {
    const { result } = await own.send('Target.getTargets');
    const target = result.targetInfos.find(
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
            expression: `document.documentElement?.getAttribute(${JSON.stringify(name)}) ?? null`,
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

async function guardPage(t, lag) {
  const seven = await chrome.page(t);
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  t.after(() => socket.close());
  socket.onmessage = ({ data }) =>
    void seven.evaluate((message) => window.cdpIn(message), data).catch(() => false);
  await seven.expose('cdpOut', (command) => {
    const send = () => socket.readyState === 1 && socket.send(JSON.stringify(command));
    if (lag && command.method === 'Target.detachFromTarget') setTimeout(send, lag);
    else send();
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
  await seven.evaluate(async () => {
    const { guardProtected } = await import(new URL('guard.js', location.href).href);
    const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
    const connection = guardProtected(
      extensionConnection(globalThis.sliccExtension.cdp),
      location.origin
    );
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
  });
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
  return { seven, send, go, events, attach };
}

const targets = () => ({
  seven: (path) => `${SEVEN}${path === '/csp' ? '/probe-csp.html' : '/probe-doc.html'}`,
  vault: (path) => `${VAULT}${path}`,
});
const sevenPages = (seven) => {
  const body = (head, inline) =>
    `<!doctype html><html><head>${head}<title>STAND</title></head><body><h1>STAND-BODY</h1>${inline}<script>console.log('STAND-CONSOLE ' + location.host);document.documentElement.setAttribute('data-locale', Intl.DateTimeFormat().resolvedOptions().locale);document.documentElement.setAttribute('data-tz', Intl.DateTimeFormat().resolvedOptions().timeZone);new Image().src = 'http://localhost:${standPort}/pixel' + location.search;</script></body></html>`;
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

for (const [detach, lag] of DETACH) {
  test(`C1–C4 and E1 at registration, ${detach} detach`, { timeout: 20 * 60 * 1000 }, async (t) => {
    const guard = await guardPage(t, lag);
    sevenPages(guard.seven);
    for (const [kind, setup, prefix] of [
      ['C', registrations.C, null],
      ['E1', registrations.E1, 'E1'],
    ]) {
      for (const trigger of ['href', 302, 'popup', 'iframe']) {
        if (kind === 'E1' && trigger !== 'href') continue;
        for (const [name, at] of Object.entries(targets())) {
          const id = `${prefix ?? VECTOR[trigger]}.${name}`;
          const to = at('/doc');
          await t.test(`${id} control`, async () => {
            const plainTo = trigger === 'iframe' ? `${OTHER}/doc?c=${id}` : `${OTHER}/doc?c=${id}`;
            const children = trigger === 'popup' || trigger === 'iframe';
            const onPlain = await controlThroughHarness(
              `${id}:plain`,
              setup,
              trigger,
              plainTo,
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
              beacons.some((b) => b.id === `${id}:protected`),
              `${id} control beacon`
            );
          });
          await t.test(`${id} protected`, async () => {
            const targetId = await tab(`${PLAIN}/doc`);
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
              if (trigger === 'popup' || trigger === 'iframe') {
                const auto = await guard.send(
                  'Target.setAutoAttach',
                  { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
                  session
                );
                assert.equal(auto.error, undefined);
              }
              const before = (await guard.events()).length;
              await guard.go(TRIGGERS[trigger](`${to}?p=${id}`), session);
              const seen = await readAttribute(`${to}`, 'data-k', lag ? lag + 3000 : 4000);
              assert.equal(seen.value, null, `${id}: no attribute on the protected document`);
              assert.ok(!beacons.some((b) => b.id === id), `${id}: no beacon`);
              if (trigger === 'popup' || trigger === 'iframe') {
                const later = (await guard.events()).slice(before);
                assert.ok(
                  !later.some(
                    (event) =>
                      event.method === 'Target.attachedToTarget' &&
                      JSON.stringify(event).includes(new URL(to).host)
                  ),
                  `${id}: the protected ${trigger} was not attached to the client`
                );
              }
            } finally {
              const { result } = await own.send('Target.getTargets');
              const extra = result.targetInfos.filter(
                (info) => info.type === 'page' && info.url.startsWith(to)
              );
              await closeAll([targetId, ...extra.map((info) => info.targetId)]);
            }
          });
        }
      }
    }
  });

  test(`E2–E5, ${detach} detach`, { timeout: 20 * 60 * 1000 }, async (t) => {
    const guard = await guardPage(t, lag);
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
          await guard.go(TRIGGERS.href(`${at('/doc')}?e2p`), session);
          await pause(lag ? lag + 2000 : 2500);
          assert.ok(
            !(await guard.events()).slice(before).some((e) => e.method === 'Runtime.bindingCalled'),
            'E2: no bindingCalled'
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
          await guard.go(TRIGGERS.href(`${to}?e3p`), session);
          const seen = await readAttribute(to, 'data-k', lag ? lag + 3000 : 4000);
          assert.equal(seen.value, null, 'E3: the protected page kept its CSP');
        } finally {
          await closeAll([targetId]);
        }
      });

      await t.test(`E4.${name} control`, async () => {
        for (const to of [`${OTHER}/doc?e4`, `${at('/doc')}?e4c`]) {
          const targetId = await tab(`${PLAIN}/doc`);
          try {
            const { send } = await harness(targetId);
            await send('Debugger.enable');
            const condition = `document.documentElement.setAttribute('data-k', 'E4'), false`;
            await send('Debugger.setBreakpointByUrl', {
              urlRegex: '.*',
              lineNumber: 0,
              columnNumber: 0,
              condition,
            });
            await send('DOMDebugger.setEventListenerBreakpoint', { eventName: 'DOMContentLoaded' });
            const from = own.events.length;
            await send('Runtime.evaluate', { expression: TRIGGERS.href(to) });
            await pause(2500);
            const paused = own.events.slice(from).some((e) => e.method === 'Debugger.paused');
            for (const e of own.events.slice(from))
              if (e.method === 'Debugger.paused') await send('Debugger.resume');
            const seen = await readAttribute(to, 'data-k', 2000);
            assert.ok(
              paused || seen.value === 'E4',
              `E4 control on ${to}: breakpoint condition evaluated or paused`
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
            assert.match(
              (await guard.send(method, params, session)).error?.message ?? '',
              DEBUGGER,
              method
            );
          }
          const before = (await guard.events()).length;
          await guard.go(TRIGGERS.href(`${at('/doc')}?e4p`), session);
          const seen = await readAttribute(at('/doc'), 'data-k', lag ? lag + 3000 : 4000);
          assert.equal(seen.value, null, 'E4: no condition evaluated in the protected document');
          assert.ok(
            !(await guard.events()).slice(before).some((e) => e.method === 'Debugger.paused'),
            'E4: no Debugger.paused'
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
          const before = (await guard.events()).length;
          const to = at('/doc');
          await guard.go(TRIGGERS.href(`${to}?e5p`), session);
          await pause(lag ? lag + 3000 : 3000);
          const host = new URL(to).host;
          const later = JSON.stringify((await guard.events()).slice(before));
          assert.ok(
            !later.includes(`STAND-CONSOLE ${host}`),
            'E5: no console event from the protected document'
          );
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

  test(`E6 session overrides, ${detach} detach`, { timeout: 20 * 60 * 1000 }, async (t) => {
    const guard = await guardPage(t, lag);
    sevenPages(guard.seven);
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
      [
        'netcond',
        'Network.emulateNetworkConditions',
        { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        'offline',
      ],
      ['locale', 'Emulation.setLocaleOverride', { locale: 'de-CH' }, 'data-locale'],
      ['timezone', 'Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Chatham' }, 'data-tz'],
    ];
    const value = { locale: 'de-CH', timezone: 'Pacific/Chatham' };
    for (const [name, at] of Object.entries(targets())) {
      for (const [key, method, params, check] of overrides) {
        const id = `E6.${key}.${name}`;
        if (name === 'seven' && typeof check === 'function') continue;
        const observe = async (to, tag, mark) => {
          const path = new URL(to).pathname;
          if (typeof check === 'function') {
            await pause(2000);
            return heard.some((hit) => hit.path.includes(tag) && check(hit));
          }
          if (check === null || check === 'offline') {
            await pause(2500);
            const loaded =
              heard.some((hit) => hit.path === `${path}?${tag}`) ||
              chrome.requests.slice(mark).some((at) => at.startsWith('/probe-doc'));
            if (check === 'offline') return !loaded;
            return (
              loaded &&
              !heard.some((hit) => hit.path.startsWith('/pixel') && hit.path.includes(tag))
            );
          }
          return (await readAttribute(to, check, 3000)).value === value[key];
        };
        await t.test(`${id} control`, async () => {
          for (const [to, tag] of [
            [`${OTHER}/doc?${id}:plain`, `${id}:plain`],
            [`${at('/doc')}?${id}:protected`, `${id}:protected`],
          ]) {
            if (name === 'seven' && typeof check === 'function' && tag.endsWith('protected'))
              continue;
            const targetId = await tab(`${PLAIN}/doc`);
            try {
              const { send } = await harness(targetId);
              await send('Network.enable');
              assert.equal((await send(method, params)).error, undefined, method);
              const mark = chrome.requests.length;
              await send('Runtime.evaluate', { expression: TRIGGERS.href(to) });
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
            const to = `${at('/doc')}?${tag}`;
            const mark = chrome.requests.length;
            await guard.go(TRIGGERS.href(to), session);
            if (lag) await pause(lag);
            assert.equal(
              await observe(to, tag, mark),
              false,
              `${id}: not applied to the protected document`
            );
          } finally {
            await closeAll([targetId]);
          }
        });
      }
    }
  });
}

test('C5 and C6 on the guard path', { timeout: 20 * 60 * 1000 }, async (t) => {
  const guard = await guardPage(t, 0);
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
              (e) => e.method === 'Fetch.requestPaused' && e.params.request.url.includes('/doc?c5')
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
        await guard.go(TRIGGERS.href(`${to}?c5p`), session);
        await pause(3000);
        const later = (await guard.events()).slice(before);
        assert.ok(
          !later.some(
            (e) =>
              (e.method === 'Fetch.requestPaused' || e.method === 'Fetch.authRequired') &&
              JSON.stringify(e).includes(new URL(to).host)
          ),
          'C5: no paused event for the protected document reached the client'
        );
        const guessed = await guard.send(
          'Fetch.fulfillRequest',
          { requestId: 'interception-job-1.0', responseCode: 200, body: '' },
          session
        );
        assert.ok(
          [UNSEEN, PROTECTED].includes(guessed.error?.message),
          `C5: fulfil refused (${guessed.error?.message})`
        );
        const shown = await readAttribute(to, 'data-k', 1500);
        assert.equal(shown.value, null, 'C5: the protected page shows its real body');
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
        for (const [method, params, at] of [
          ['Network.getCookies', { urls: [`${origin}/`] }, session],
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
