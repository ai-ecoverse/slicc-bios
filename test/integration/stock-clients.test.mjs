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
    '--host-resolver-rules=MAP ordinary.test 127.0.0.1, MAP frame.test 127.0.0.1',
  ],
});
const { port } = await devtools(chrome);
const browser = await debuggerUrl(port);
const SEVEN = `${new URL(chrome.url).origin}/os/`;
const VAULT = `${chrome.vault.origin}/`;
const protectedUrl = (url) => [SEVEN, VAULT].some((at) => url.startsWith(new URL(at).origin));
after(() => {
  chrome.close();
  fixture.close();
});

const holds = [];
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
    if (took > HELD_MS) holds.push(`${route} ${client} ${name}: ${took} ms`);
  }
}

async function bridge(t) {
  const seven = await chrome.page(t);
  const extension = new WebSocket(browser, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    extension.once('open', resolve);
    extension.once('error', reject);
  });
  t.after(() => extension.close());
  extension.on('message', (data) => {
    void seven.evaluate((text) => window.stockCdpIn(text), data.toString()).catch(() => false);
  });
  await seven.expose('stockCdpOut', (command) => {
    if (extension.readyState === 1) extension.send(JSON.stringify(command));
  });
  await seven.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(globalThis, 'crestDevTools', { configurable: true, value: Object.freeze({ webSocketDebuggerUrl: ${JSON.stringify(browser)} }) });`,
  });
  await seven.init(() => {
    globalThis.sliccKernelDebug = true;
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
    else if (socket.readyState === 1) socket.send(text);
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
  return `ws://127.0.0.1:${server.address().port}`;
}

async function playwright(route, endpoint) {
  const run = (name, work) => step(route, 'playwright', name, work);
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
    await run('click', () => page.click('#go'));
    assert.equal(await page.textContent('#out'), 'clicked');
    await run('fill', () => page.fill('#name', 'stock'));
    assert.equal(await page.inputValue('#name'), 'stock');
    assert.equal(await run('evaluate', () => page.evaluate(() => 6 * 7)), 42);
    assert.ok((await run('screenshot', () => page.screenshot())).length > 100);
    const cookies = await run('cookies', () => context.cookies(ORDINARY));
    assert.ok(cookies.some((cookie) => cookie.name === 'stock'));
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
    for (const open of context.pages()) await open.close().catch(() => {});
  } finally {
    await connected.close();
  }
}

async function puppeteerFlow(route, endpoint) {
  const run = (name, work) => step(route, 'puppeteer', name, work);
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
    await run('click', () => page.click('#go'));
    assert.equal(await page.$eval('#out', (node) => node.textContent), 'clicked');
    await run('type', () => page.type('#name', 'stock'));
    assert.equal(await page.$eval('#name', (node) => node.value), 'stock');
    assert.equal(await run('evaluate', () => page.evaluate(() => 6 * 7)), 42);
    assert.ok((await run('screenshot', () => page.screenshot())).length > 100);
    const cookies = await run('cookies', () => page.cookies());
    assert.ok(cookies.some((cookie) => cookie.name === 'stock'));
    const [popup] = await run('popup', () =>
      Promise.all([new Promise((resolve) => page.once('popup', resolve)), page.click('#open')])
    );
    await run('popup load', () => popup.waitForFunction(() => document.readyState === 'complete'));
    assert.equal(await popup.title(), 'popup');
    await run('iframe', () => page.goto(`${ORDINARY}/framed`));
    const frame = await run('iframe frame', async () => {
      for (;;) {
        const found = page.frames().find((item) => item.url().startsWith(FRAME));
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
    for (const open of await connected.pages()) await open.close().catch(() => {});
  } finally {
    await connected.disconnect();
  }
}

for (const route of ['devtools', 'extension'])
  test(`stock Playwright and Puppeteer drive an ordinary page through the guard on the ${route} route, and stay out of seven and the vault`, {
    timeout: 10 * 60 * 1000,
  }, async (t) => {
    const endpoint = `${await bridge(t)}/${route}`;
    t.after(() => console.log(`STOCK-HOLDS ${route} ${JSON.stringify(holds.splice(0))}`));
    await t.test('Playwright', () => playwright(route, endpoint));
    await t.test('Puppeteer', () => puppeteerFlow(route, endpoint));
  });
