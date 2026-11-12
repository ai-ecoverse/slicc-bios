import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { chromium } from 'playwright-core';
import puppeteer from 'puppeteer-core';
import { WebSocket, WebSocketServer } from 'ws';
import { boot } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';

const SCRIPTS = /slicc: refused: scripts and bindings for later documents/;
const SETTINGS = /slicc: refused: settings for a whole session/;
const OUT_OF_REACH = /slicc: refused: seven’s own pages and the vault are out of reach/;
const STEP_MS = 30000;
const HELD_MS = 5000;

const fixture = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const html = (body, head = '') => {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'stock=1; Path=/' });
    res.end(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
  };
  if (url.pathname === '/page')
    return html(
      `<button id="go" onclick="document.querySelector('#out').textContent = 'clicked'">go</button><p id="out">waiting</p><input id="name"><a id="open" href="/popup" target="_blank">open</a>`,
      '<title>page</title>'
    );
  if (url.pathname === '/popup') return html('<p>popup</p>', '<title>popup</title>');
  if (url.pathname === '/framed')
    return html(
      `<iframe id="frame" src="http://frame.test:${fixture.address().port}/inner"></iframe>`,
      '<title>framed</title>'
    );
  if (url.pathname === '/framed-same')
    return html('<iframe id="frame" src="/inner"></iframe>', '<title>framed</title>');
  if (url.pathname === '/inner') return html('<p id="inner">inner</p>', '<title>inner</title>');
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const ORDINARY = `http://ordinary.test:${fixture.address().port}`;
const FRAME = `http://frame.test:${fixture.address().port}`;

const chrome = await launch({
  tools: false,
  args: [
    '--remote-allow-origins=*',
    '--host-resolver-rules=MAP ordinary.test 127.0.0.1, MAP frame.test 127.0.0.1, MAP vault.sliccy.ai 127.0.0.1',
  ],
});
const { port } = await devtools(chrome);
const browser = await debuggerUrl(port);
const SEVEN = `${new URL(chrome.url).origin}/os/`;
const VAULT = `http://vault.sliccy.ai:${fixture.address().port}/page`;
const protectedUrl = (url) => [SEVEN, VAULT].some((at) => url.startsWith(new URL(at).origin));
const VAULT_COOKIE = 'stock-vault-secret';
const vaultCookie = (cookies) =>
  cookies.filter((cookie) => cookie.name === VAULT_COOKIE || cookie.domain.includes('sliccy.ai'));
after(() => {
  chrome.close();
  fixture.close();
});

const holds = [];
const answers = [];
const pending = new Map();
const traffic = [];
const chromeShots = new Map();
let readChrome = async () => [];
const snapshots = new Map();
let current = '';
const watched = (id, text, outgoing) => {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  const short = (value) => (typeof value === 'string' ? value.slice(0, 6) : '');
  const info = message.params?.targetInfo;
  traffic.push(
    [
      outgoing ? '>' : '<',
      message.method ?? `#${message.id}`,
      short(message.sessionId),
      short(message.params?.sessionId),
      info ? `${info.type} ${info.url}` : '',
      message.params?.waitingForDebugger ? 'paused' : '',
      message.error ? message.error.message.slice(0, 40) : '',
    ]
      .filter(Boolean)
      .join(' ')
  );
  if (traffic.length > 40) traffic.shift();
  if (message.id === undefined) return;
  const key = `${id}:${message.sessionId ?? ''}:${message.id}`;
  if (outgoing) {
    pending.set(key, { method: message.method, at: Date.now(), by: current });
    return;
  }
  const asked = pending.get(key);
  if (!asked) return;
  pending.delete(key);
  const took = Date.now() - asked.at;
  if (message.error) {
    answers.push(`${asked.by} refused ${asked.method}: ${message.error.message.slice(0, 160)}`);
    if (!snapshots.has(asked.method)) snapshots.set(asked.method, [...traffic]);
  }
  if (took > HELD_MS) answers.push(`${asked.by} held ${asked.method}: ${took} ms`);
};
async function step(route, client, name, work) {
  const started = Date.now();
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${client} ${name} on the ${route} route took over ${STEP_MS} ms`)),
          STEP_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    const took = Date.now() - started;
    if (took > HELD_MS) {
      holds.push(`${route} ${client} ${name}: ${took} ms`);
      snapshots.set(`held ${client} ${name}`, [...traffic]);
      chromeShots.set(`held ${client} ${name}`, await readChrome());
    }
  }
}

async function unguarded(t) {
  const socket = new WebSocket(browser, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  t.after(() => socket.close());
  const waiting = new Map();
  let next = 0;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const done = waiting.get(message.id);
    if (!done) return;
    waiting.delete(message.id);
    done(message);
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      next += 1;
      waiting.set(next, (message) =>
        message.error ? reject(new Error(message.error.message)) : resolve(message.result)
      );
      socket.send(JSON.stringify({ id: next, method, params }));
    });
}

async function vaultOpen(t) {
  const send = await unguarded(t);
  await send('Storage.setCookies', {
    cookies: [{ name: VAULT_COOKIE, value: 'v', url: VAULT }],
  });
  const { targetId } = await send('Target.createTarget', { url: VAULT, background: true });
  t.after(() => send('Target.closeTarget', { targetId }).catch(() => {}));
}

async function bridge(t) {
  const seven = await chrome.page(t);
  const extension = new WebSocket(browser, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    extension.once('open', resolve);
    extension.once('error', reject);
  });
  t.after(() => extension.close());
  const relayed = new Map();
  const recent = [];
  extension.on('message', (data) => {
    const text = data.toString();
    relayed.delete(JSON.parse(text).id);
    void seven.evaluate((text) => window.stockCdpIn(text), text).catch(() => false);
  });
  await seven.expose('stockCdpOut', (command) => {
    const entry = { method: command.method, sessionId: command.sessionId, at: Date.now() };
    relayed.set(command.id, entry);
    recent.push(entry);
    if (recent.length > 60) recent.shift();
    if (extension.readyState === 1) extension.send(JSON.stringify(command));
  });
  await seven.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(globalThis, 'crestDevTools', { configurable: true, value: Object.freeze({ webSocketDebuggerUrl: ${JSON.stringify(browser)} }) });`,
  });
  await seven.init(() => {
    globalThis.sliccKernelDebug = true;
    const Native = window.WebSocket;
    window.stockWire = new Map();
    window.stockQuiet = new Set();
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).includes('/devtools/browser/')) return;
        const send = this.send.bind(this);
        this.send = (text) => {
          const command = JSON.parse(text);
          const entry = { method: command.method, sessionId: command.sessionId, at: Date.now() };
          window.stockWire.set(command.id, entry);
          window.stockRecent = [...(window.stockRecent ?? []).slice(-59), entry];
          if (command.method === 'Target.getTargets') window.stockQuiet.add(command.id);
          else
            window.stockChrome = [
              ...(window.stockChrome ?? []).slice(-199),
              `> ${command.method} ${String(command.sessionId ?? '').slice(0, 6)}`,
            ];
          return send(text);
        };
        this.addEventListener('message', ({ data }) => {
          const message = JSON.parse(data);
          window.stockWire.delete(message.id);
          if (window.stockQuiet.delete(message.id)) return;
          const params = message.params ?? {};
          const info = params.targetInfo;
          const note = [
            message.error?.message?.slice(0, 60),
            info && `${info.type} ${String(info.url).slice(0, 50)}`,
            params.waitingForDebugger && 'paused',
            params.context?.name && `ctx ${params.context.name}`,
            params.frame?.url && `frame ${String(params.frame.url).slice(0, 50)}`,
            params.url && String(params.url).slice(0, 50),
          ]
            .filter(Boolean)
            .join(' ');
          window.stockChrome = [
            ...(window.stockChrome ?? []).slice(-199),
            `< ${message.method ?? `#${message.id}`} ${String(message.sessionId ?? '').slice(0, 6)} ${note}`.trim(),
          ];
        });
      }
    };
    const pending = new Map();
    const listeners = new Set();
    let next = 0;
    window.stockCdpIn = (text) => {
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
            next += 1;
            const id = next;
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              window.stockCdpOut(JSON.stringify({ id, method, params, sessionId }));
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
  const sockets = new Map();
  await seven.expose('stockOut', ({ id, text, closed }) => {
    const socket = sockets.get(id);
    if (!socket) return;
    if (closed !== undefined) socket.close(1011, closed.slice(0, 120));
    else if (socket.readyState === 1) {
      watched(id, text, false);
      socket.send(text);
    }
  });
  await seven.evaluate(() => {
    window.stockConnections = new Map();
    window.stockOpen = async (id, runtime) => {
      try {
        const connection = await globalThis.sliccBrowserHook({ runtime });
        connection.onmessage = (text) => window.stockOut(JSON.stringify({ id, text }));
        connection.onclose = (reason) =>
          window.stockOut(JSON.stringify({ id, closed: String(reason ?? '') }));
        window.stockConnections.set(id, connection);
        return true;
      } catch (error) {
        return String(error?.message ?? error);
      }
    };
    window.stockSend = (id, text) => {
      window.stockConnections.get(id)?.send(text);
      return true;
    };
    window.stockClose = (id) => {
      window.stockConnections.get(id)?.close();
      window.stockConnections.delete(id);
      return true;
    };
    return true;
  });
  const server = createServer((_, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 * 1024 });
  let ids = 0;
  wss.on('connection', (socket, req) => {
    ids += 1;
    const id = ids;
    const runtime = new URL(req.url, 'http://bridge').pathname.slice(1);
    sockets.set(id, socket);
    let chain = seven
      .evaluate((id, runtime) => window.stockOpen(id, runtime), id, runtime)
      .then((opened) => {
        if (opened !== true) socket.close(1011, String(opened).slice(0, 120));
      });
    socket.on('message', (data) => {
      const text = data.toString();
      watched(id, text, true);
      chain = chain
        .then(() => seven.evaluate((id, text) => window.stockSend(id, text), id, text))
        .catch(() => {});
    });
    socket.on('close', () => {
      sockets.delete(id);
      chain = chain.then(() => seven.evaluate((id) => window.stockClose(id), id)).catch(() => {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of wss.clients) socket.terminate();
    server.close();
  });
  readChrome = () => seven.evaluate(() => window.stockChrome ?? []).catch(() => []);
  const wire = async () => {
    const now = Date.now();
    const devtools = await seven.evaluate(() => [...window.stockWire.values()]).catch(() => []);
    const devtoolsRecent = await seven.evaluate(() => window.stockRecent ?? []).catch(() => []);
    const line = (entry) => `${entry.method} ${entry.sessionId ?? 'browser'} -${now - entry.at} ms`;
    const chrome = await seven.evaluate(() => window.stockChrome ?? []).catch(() => []);
    return {
      chrome,
      unanswered: [...devtools, ...relayed.values()]
        .filter((entry) => now - entry.at > HELD_MS)
        .map(line),
      recent: [...devtoolsRecent, ...recent]
        .sort((a, b) => a.at - b.at)
        .slice(-60)
        .map(line),
    };
  };
  return { endpoint: `ws://127.0.0.1:${server.address().port}`, wire };
}

async function playwright(route, endpoint) {
  const run = (name, work) => step(route, 'playwright', name, work);
  current = `${route} playwright`;
  const connected = await run('connect', () => chromium.connectOverCDP(endpoint));
  try {
    const [context] = connected.contexts();
    assert.ok(context, 'the default context');
    assert.ok(
      !context.pages().some((page) => protectedUrl(page.url())),
      'no protected page in the default context'
    );
    const page = await run('newPage', () => context.newPage());
    await run('goto', () => page.goto(`${ORDINARY}/page`));
    await visibility(route, 'playwright', page);
    await run('click', () => page.click('#go'));
    assert.equal(await page.textContent('#out'), 'clicked');
    await run('fill', () => page.fill('#name', 'stock'));
    assert.equal(await page.inputValue('#name'), 'stock');
    assert.equal(await run('evaluate', () => page.evaluate(() => 6 * 7)), 42);
    assert.ok((await run('screenshot', () => page.screenshot())).length > 100);
    const cookies = await run('cookies', () => context.cookies(ORDINARY));
    assert.ok(cookies.some((cookie) => cookie.name === 'stock'));
    const all = await run('all cookies', () => context.cookies());
    assert.ok(all.some((cookie) => cookie.name === 'stock'));
    assert.deepEqual(vaultCookie(all), [], 'no vault cookie reaches the client');
    const [popup] = await run('popup', () =>
      Promise.all([page.waitForEvent('popup'), page.click('#open')])
    );
    await run('popup load', () => popup.waitForLoadState());
    assert.equal(await popup.title(), 'popup');
    await run('iframe', () => page.goto(`${ORDINARY}/framed`));
    const frame = await run('iframe frame', async () => {
      for (;;) {
        const found = page.frames().find((item) => item.url().startsWith(FRAME));
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
    assert.equal(await run('iframe read', () => frame.textContent('#inner')), 'inner');
    const other = await run('newContext', () => connected.newContext());
    const second = await run('newContext newPage', () => other.newPage());
    await run('newContext goto', () => second.goto(`${ORDINARY}/page`));
    assert.equal(await second.title(), 'page');
    await other.close();
    for (const url of [SEVEN, VAULT])
      await assert.rejects(
        run(`goto ${url}`, () => page.goto(url)),
        OUT_OF_REACH,
        `Playwright reaches ${url}`
      );
    assert.ok(!protectedUrl(page.url()), `the page stays off the protected origins: ${page.url()}`);
    const late = await run('newPage for group 2', () => context.newPage());
    await assert.rejects(late.addInitScript('window.stockInit = 1'), SCRIPTS);
    await assert.rejects(
      late.exposeFunction('stockExposed', () => 1),
      SCRIPTS
    );
    await assert.rejects(
      late.route('**/*', (route) => route.continue()),
      SETTINGS
    );
    for (const open of [page, popup, late]) await open.close().catch(() => {});
  } finally {
    await connected.close();
  }
}

async function visibility(route, client, page) {
  const seen = await page
    .evaluate(() => [document.visibilityState, document.hasFocus()])
    .catch((error) => String(error.message ?? error));
  process.stdout.write(`STOCK-VISIBILITY ${route} ${client} ${JSON.stringify(seen)}\n`);
}

async function puppeteerFlow(route, endpoint) {
  const run = (name, work) => step(route, 'puppeteer', name, work);
  current = `${route} puppeteer`;
  const connected = await run('connect', () =>
    puppeteer.connect({ browserWSEndpoint: endpoint, protocolTimeout: STEP_MS })
  );
  try {
    assert.ok(
      !(await connected.pages()).some((page) => protectedUrl(page.url())),
      'no protected page listed'
    );
    const page = await run('newPage', () => connected.newPage());
    await run('goto', () => page.goto(`${ORDINARY}/page`));
    await visibility(route, 'puppeteer', page);
    await run('click', () => page.click('#go'));
    assert.equal(await page.$eval('#out', (node) => node.textContent), 'clicked');
    await run('type', () => page.type('#name', 'stock'));
    assert.equal(await page.$eval('#name', (node) => node.value), 'stock');
    assert.equal(await run('evaluate', () => page.evaluate(() => 6 * 7)), 42);
    assert.ok((await run('screenshot', () => page.screenshot())).length > 100);
    const cookies = await run('cookies', () => page.cookies());
    assert.ok(cookies.some((cookie) => cookie.name === 'stock'));
    const all = await run('all cookies', () => connected.cookies());
    assert.ok(all.some((cookie) => cookie.name === 'stock'));
    assert.deepEqual(vaultCookie(all), [], 'no vault cookie reaches the client');
    const [popup] = await run('popup', () =>
      Promise.all([new Promise((resolve) => page.once('popup', resolve)), page.click('#open')])
    );
    await run('popup load', () => popup.waitForFunction(() => document.readyState === 'complete'));
    assert.equal(await popup.title(), 'popup');
    await run('iframe', () => page.goto(`${ORDINARY}/framed-same`));
    const frame = await run('iframe frame', async () => {
      for (;;) {
        const found = page.frames().find((item) => item.url().startsWith(`${ORDINARY}/inner`));
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
    assert.equal(
      await run('iframe read', () => frame.$eval('#inner', (node) => node.textContent)),
      'inner'
    );
    for (const url of [SEVEN, VAULT])
      await assert.rejects(
        run(`goto ${url}`, () => page.goto(url)),
        OUT_OF_REACH,
        `Puppeteer reaches ${url}`
      );
    assert.ok(!protectedUrl(page.url()), `the page stays off the protected origins: ${page.url()}`);
    const late = await run('newPage for group 2', () => connected.newPage());
    await assert.rejects(late.evaluateOnNewDocument('window.stockInit = 1'), SCRIPTS);
    await assert.rejects(
      late.exposeFunction('stockExposed', () => 1),
      SCRIPTS
    );
    await assert.rejects(late.setRequestInterception(true), SETTINGS);
    for (const open of [page, popup, late]) await open.close().catch(() => {});
  } finally {
    await connected.disconnect();
  }
}

for (const route of ['devtools', 'extension'])
  test(`stock Playwright and Puppeteer drive an ordinary page through the guard on the ${route} route, and stay out of seven and the vault`, {
    timeout: 10 * 60 * 1000,
  }, async (t) => {
    const opened = await bridge(t);
    await vaultOpen(t);
    const endpoint = `${opened.endpoint}/${route}`;
    t.after(() => {
      const unanswered = [...pending.values()].map(
        (asked) => `${asked.by} unanswered ${asked.method}: ${Date.now() - asked.at} ms`
      );
      pending.clear();
      console.log(`STOCK-HOLDS ${route} ${JSON.stringify(holds.splice(0))}`);
      console.log(
        `STOCK-ANSWERS ${route} ${JSON.stringify([...answers.splice(0), ...unanswered])}`
      );
    });
    await t.test('Playwright', () => playwright(route, endpoint));
    await t.test('Puppeteer', () => puppeteerFlow(route, endpoint));
    const wired = await opened.wire();
    for (const [name, lines] of chromeShots)
      console.log(`STOCK-CHROME ${route} at ${name}\n${lines.join('\n')}`);
    chromeShots.clear();
    console.log(`STOCK-WIRE ${route} ${JSON.stringify({ unanswered: wired.unanswered })}`);
    for (const [method, lines] of snapshots)
      console.log(`STOCK-TRAFFIC ${route} before ${method}\n${lines.join('\n')}`);
    snapshots.clear();
  });
