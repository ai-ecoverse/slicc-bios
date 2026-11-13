import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import { boot, ready } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { CLI } from './cli.mjs';
import { extensionOver } from './fake-extension.mjs';
import { model, startHub } from './fake-hub.mjs';
import { linkNode } from './linked-node.mjs';
import {
  dial,
  escaped,
  httpJson,
  items,
  NO_GRANT,
  STOPPED,
  SWITCHED_OFF,
  scratch,
  setSwitch,
  startCdp,
  stopChip,
  waitListening,
  within,
} from './remote-cdp.mjs';

export const OUT_OF_REACH =
  'slicc: refused: seven’s own pages and the vault are out of reach of browser automation';
export const SCRIPTS =
  'slicc: refused: scripts and bindings for later documents could run in seven’s pages or the vault, so the guard doesn’t allow them; run a script in the page you see with Runtime.evaluate instead';
export const SETTINGS =
  'slicc: refused: settings for a whole session (headers, user agent, locale, time zone, cache, network conditions, blocked URLs, emulation) could reach seven’s pages or the vault, so the guard doesn’t allow them; change a request through Fetch instead';
const RELAY = 'https://www.sliccy.ai/auth/callback';
const SEVEN_CLIENT = 'experience-catalyst-prod';
const SIGN_IN_MARK = 'STOCK-SIGN-IN-BODY';
const HELD_MARK = 'STOCK-HELD-BODY';
const STEP_MS = 60000;
const HELD_MS = 5000;
const PIN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
).devDependencies['@ai-ecoverse/slicc'];
const CHROME_ARGS = [
  '--remote-allow-origins=*',
  '--disable-popup-blocking',
  '--host-resolver-rules=MAP ordinary.test 127.0.0.1, MAP frame.test 127.0.0.1, MAP idp.test 127.0.0.1, MAP vault.sliccy.ai 127.0.0.1',
];

function fixtureServer() {
  const hits = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const hit = `${url.hostname}${url.pathname}`;
    hits.set(hit, (hits.get(hit) ?? 0) + 1);
    const port = server.address().port;
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
        `<iframe id="frame" src="http://frame.test:${port}/inner"></iframe>`,
        '<title>framed</title>'
      );
    if (url.pathname === '/framed-same')
      return html('<iframe id="frame" src="/inner"></iframe>', '<title>framed</title>');
    if (url.pathname === '/inner') return html('<p id="inner">inner</p>', '<title>inner</title>');
    if (url.pathname === '/held')
      return html(`<p>${HELD_MARK}</p>`, `<title>${HELD_MARK}-title</title>`);
    if (url.pathname === '/ims/authorize/v2')
      return html(`<h1>${SIGN_IN_MARK}</h1>`, `<title>${SIGN_IN_MARK}-title</title>`);
    res.writeHead(404);
    res.end();
  });
  return { server, hits };
}

async function unguarded(ws) {
  const socket = new WebSocket(ws, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const waiting = new Map();
  let next = 0;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const done = waiting.get(message.id);
    if (!done) return;
    waiting.delete(message.id);
    done(message);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      next += 1;
      const id = next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method}: no answer in 10 s`));
      }, 10000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

async function until(name, found, ms = STEP_MS - 5000) {
  const started = Date.now();
  for (;;) {
    const value = await found();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`no ${name} in ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function recordedTransport(url) {
  const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const transport = {
    onmessage: undefined,
    onclose: undefined,
    send: (message) => socket.send(message),
    close: () => socket.close(),
  };
  const trace = [];
  const note = (way, text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const info = message.params?.targetInfo;
    trace.push(
      [
        way,
        message.method ?? `#${message.id}`,
        info ? `${info.type} ${info.url}` : '',
        message.params?.waitingForDebugger ? 'paused' : '',
        message.error ? message.error.message.slice(0, 80) : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
    if (trace.length > 60) trace.shift();
  };
  transport.send = (message) => {
    note('>', message);
    socket.send(message);
  };
  socket.on('message', (data) => {
    note('<', data.toString());
    transport.onmessage?.(data.toString());
  });
  const closed = new Promise((resolve) =>
    socket.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
      transport.onclose?.();
    })
  );
  return { transport, closed, trace };
}

const bounded = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(`no answer to ${what} in ${ms} ms`), ms)),
  ]);

export function stockChain(route, { chain = 'tray' } = {}) {
  const label = `${chain} ${route}`;
  const { server, hits } = fixtureServer();
  const holds = [];
  const steps = [];
  let rig;
  const start = async () => {
    if (rig) return rig;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const chrome = await launch({ tools: false, args: CHROME_ARGS });
    const { port: debugPort } = await devtools(chrome);
    const browserUrl = await debuggerUrl(debugPort);
    const ordinary = `http://ordinary.test:${port}`;
    const vaultOrigin = `http://vault.sliccy.ai:${port}`;
    const seven = new URL(chrome.url).origin;
    rig = {
      chrome,
      debugPort,
      browserUrl,
      ordinary,
      frame: `http://frame.test:${port}`,
      seven: `${seven}/os/`,
      sevenOrigin: seven,
      vault: `${vaultOrigin}/page`,
      vaultOrigin,
      signIn: `http://idp.test:${port}/ims/authorize/v2?client_id=${SEVEN_CLIENT}&redirect_uri=${encodeURIComponent(RELAY)}&response_type=code`,
      callbackOnly: `http://idp.test:${port}/ims/authorize/v2?client_id=any&redirect_uri=${encodeURIComponent(RELAY)}&response_type=token`,
      idpOrigin: `http://idp.test:${port}`,
      fakeExtension: extensionOver(browserUrl),
    };
    return rig;
  };
  after(() => {
    rig?.chrome.close();
    server.close();
  });

  const protectedUrl = (url) =>
    [rig.sevenOrigin, rig.vaultOrigin, rig.idpOrigin].some((origin) => url.startsWith(origin));
  const VAULT_COOKIE = 'stock-vault-secret';
  const vaultCookie = (cookies) =>
    cookies.filter((cookie) => cookie.name === VAULT_COOKIE || cookie.domain.includes('sliccy.ai'));

  const reachless = () => ({
    seven: rig.seven,
    vault: rig.vault,
    'seven’s sign-in': rig.signIn,
    'a sign-in to seven’s callback': rig.callbackOnly,
  });

  async function step(client, name, work) {
    const started = Date.now();
    let timer;
    try {
      return await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${client} ${name} over ${label} took over ${STEP_MS} ms`)),
            STEP_MS
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      const took = Date.now() - started;
      steps.push(`${client} ${name} ${took}`);
      if (took > HELD_MS) holds.push(`${label} ${client} ${name}: ${took} ms`);
    }
  }

  async function seven(t) {
    const page = await rig.chrome.page(t);
    if (route === 'link')
      await page.init(() => {
        globalThis.sliccKernelDebug = true;
      });
    if (route === 'extension') {
      const extension = await rig.fakeExtension(page);
      t.after(extension.close);
    }
    if (route === 'devtools')
      await page.init(
        `() => Object.defineProperty(globalThis, 'crestDevTools', { configurable: true, value: Object.freeze({ webSocketDebuggerUrl: ${JSON.stringify(rig.browserUrl)} }) })`
      );
    return page;
  }

  async function linkSeven(t, page) {
    await linkNode(t, page, rig.debugPort, 'seven-browser', {
      seven: true,
      origins: [rig.sevenOrigin],
    });
    const linked = await page.evaluate(() =>
      globalThis.sliccLinkedBrowsers().map(({ runtime, seven, local }) => ({
        runtime,
        seven,
        local,
      }))
    );
    assert.ok(
      linked.some((browser) => browser.seven && browser.local),
      `a local seven: true browser on the link: ${JSON.stringify(linked)}`
    );
  }

  async function seed(t) {
    const plain = await unguarded(rig.browserUrl);
    const opened = [];
    t.after(async () => {
      for (const targetId of opened)
        await plain.send('Target.closeTarget', { targetId }).catch(() => {});
      plain.close();
    });
    await plain.send('Storage.setCookies', {
      cookies: [{ name: VAULT_COOKIE, value: 'v', url: rig.vault }],
    });
    for (const url of [rig.vault, `${rig.ordinary}/page`]) {
      const { targetId } = await plain.send('Target.createTarget', { url, background: true });
      opened.push(targetId);
    }
    await until('the vault page', () => hits.has('vault.sliccy.ai/page'));
    await until('the default page', () => hits.has('ordinary.test/page'));
  }

  async function playwrightFlow(base) {
    const run = (name, work) => step('playwright', name, work);
    const connected = await run('connect', () => chromium.connectOverCDP(base));
    try {
      const [context] = connected.contexts();
      assert.ok(context, 'the default context');
      const first = await run('default page', () =>
        until('the default page in the default context', () =>
          context.pages().find((page) => page.url() === `${rig.ordinary}/page`)
        )
      );
      assert.equal(await first.title(), 'page');
      const listed = context.pages().map((page) => page.url());
      assert.ok(!listed.some(protectedUrl), `no protected page listed: ${JSON.stringify(listed)}`);
      const page = await run('newPage', () => context.newPage());
      await run('goto', () => page.goto(`${rig.ordinary}/page`));
      assert.equal(await page.title(), 'page');
      await run('click', () => page.click('#go'));
      assert.equal(await page.textContent('#out'), 'clicked');
      await run('fill', () => page.fill('#name', 'stock'));
      assert.equal(await page.inputValue('#name'), 'stock');
      assert.equal(await run('evaluate', () => page.evaluate(() => 6 * 7)), 42);
      const shot = await run('screenshot', () => page.screenshot());
      assert.ok(shot.length > 100);
      const cookies = await run('cookies', () => context.cookies(rig.ordinary));
      assert.ok(cookies.some((cookie) => cookie.name === 'stock'));
      const all = await run('all cookies', () => context.cookies());
      assert.ok(all.some((cookie) => cookie.name === 'stock'));
      assert.deepEqual(vaultCookie(all), [], 'no vault cookie reaches the client');
      const [popup] = await run('popup', () =>
        Promise.all([page.waitForEvent('popup'), page.click('#open')])
      );
      await run('popup load', () => popup.waitForLoadState());
      assert.equal(await popup.title(), 'popup');
      await run('iframe', () => page.goto(`${rig.ordinary}/framed`));
      const frame = await run('iframe frame', async () => {
        for (;;) {
          const found = page.frames().find((item) => item.url().startsWith(rig.frame));
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
      assert.equal(await run('iframe read', () => frame.textContent('#inner')), 'inner');
      const other = await run('newContext', () => connected.newContext());
      const second = await run('newContext newPage', () => other.newPage());
      await run('newContext goto', () => second.goto(`${rig.ordinary}/page`));
      assert.equal(await second.title(), 'page');
      await other.close();
      for (const [name, url] of Object.entries(reachless()))
        await assert.rejects(
          run(`goto ${name}`, () => page.goto(url)),
          escaped(OUT_OF_REACH),
          `Playwright reaches ${name}`
        );
      assert.ok(
        !protectedUrl(page.url()),
        `the page stays off the protected origins: ${page.url()}`
      );
      const after = context.pages().map((open) => open.url());
      assert.ok(!after.some(protectedUrl), `no protected page listed: ${JSON.stringify(after)}`);
      const grouped = await run('newContext for group 2', () => connected.newContext());
      const late = await run('newPage for group 2', () => grouped.newPage());
      await assert.rejects(late.addInitScript('window.stockInit = 1'), escaped(SCRIPTS));
      await assert.rejects(
        late.exposeFunction('stockExposed', () => 1),
        escaped(SCRIPTS)
      );
      await assert.rejects(
        late.route('**/*', (route) => route.continue()),
        escaped(SETTINGS)
      );
      const again = await run('newPage after group 2', () => context.newPage());
      await run('goto after group 2', () => again.goto(`${rig.ordinary}/page`));
      await run('click after group 2', () => again.click('#go'));
      assert.equal(await again.textContent('#out'), 'clicked');
      assert.equal(await run('evaluate after group 2', () => page.evaluate(() => 6 * 7)), 42);
      for (const open of [page, popup, again]) await open.close().catch(() => {});
      await grouped.close().catch(() => {});
    } finally {
      await connected.close();
    }
  }

  async function puppeteerFlow(base) {
    const run = (name, work) => step('puppeteer', name, work);
    const connected = await run('connect', () =>
      puppeteer.connect({ browserURL: base, protocolTimeout: STEP_MS })
    );
    try {
      const first = await run('default page', () =>
        until('the default page in pages()', async () =>
          (await connected.pages()).find((page) => page.url() === `${rig.ordinary}/page`)
        )
      );
      assert.equal(await first.title(), 'page');
      const listed = (await connected.pages()).map((page) => page.url());
      assert.ok(!listed.some(protectedUrl), `no protected page listed: ${JSON.stringify(listed)}`);
      const page = await run('newPage', () => connected.newPage());
      await run('goto', () => page.goto(`${rig.ordinary}/page`));
      assert.equal(await page.title(), 'page');
      await run('click', () => page.click('#go'));
      assert.equal(await page.$eval('#out', (node) => node.textContent), 'clicked');
      await run('type', () => page.type('#name', 'stock'));
      assert.equal(await page.$eval('#name', (node) => node.value), 'stock');
      assert.equal(await run('evaluate', () => page.evaluate(() => 6 * 7)), 42);
      const shot = await run('screenshot', () => page.screenshot());
      assert.ok(shot.length > 100);
      const cookies = await run('cookies', () => page.cookies());
      assert.ok(cookies.some((cookie) => cookie.name === 'stock'));
      const all = await run('all cookies', () => connected.cookies());
      assert.ok(all.some((cookie) => cookie.name === 'stock'));
      assert.deepEqual(vaultCookie(all), [], 'no vault cookie reaches the client');
      const [popup] = await run('popup', () =>
        Promise.all([new Promise((resolve) => page.once('popup', resolve)), page.click('#open')])
      );
      await run('popup load', () =>
        popup.waitForFunction(() => document.readyState === 'complete')
      );
      assert.equal(await popup.title(), 'popup');
      await run('iframe', () => page.goto(`${rig.ordinary}/framed-same`));
      const frame = await run('iframe frame', async () => {
        for (;;) {
          const found = page
            .frames()
            .find((item) => item.url().startsWith(`${rig.ordinary}/inner`));
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
      assert.equal(
        await run('iframe read', () => frame.$eval('#inner', (node) => node.textContent)),
        'inner'
      );
      for (const [name, url] of Object.entries(reachless()))
        await assert.rejects(
          run(`goto ${name}`, () => page.goto(url)),
          escaped(OUT_OF_REACH),
          `Puppeteer reaches ${name}`
        );
      assert.ok(
        !protectedUrl(page.url()),
        `the page stays off the protected origins: ${page.url()}`
      );
      const targets = connected.targets().map((target) => target.url());
      assert.ok(!targets.some(protectedUrl), `no protected target: ${JSON.stringify(targets)}`);
      const late = await run('newPage for group 2', () => connected.newPage());
      await assert.rejects(late.evaluateOnNewDocument('window.stockInit = 1'), escaped(SCRIPTS));
      await assert.rejects(
        late.exposeFunction('stockExposed', () => 1),
        escaped(SCRIPTS)
      );
      await assert.rejects(late.setRequestInterception(true), escaped(SETTINGS));
      const again = await run('newPage after group 2', () => connected.newPage());
      await run('goto after group 2', () => again.goto(`${rig.ordinary}/page`));
      await run('click after group 2', () => again.click('#go'));
      assert.equal(await again.$eval('#out', (node) => node.textContent), 'clicked');
      assert.equal(await run('evaluate after group 2', () => page.evaluate(() => 6 * 7)), 42);
      for (const open of [page, popup, late, again]) await open.close().catch(() => {});
    } finally {
      await connected.disconnect();
    }
  }

  async function sliccLayer(page, targetId) {
    if (route !== 'link') return 'no link layer on this route';
    return page.evaluate(async (targetId) => {
      const [browser] = globalThis
        .sliccLinkedBrowsers()
        .filter((linked) => linked.seven && linked.local);
      const connection = await browser.open();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          connection.close();
          resolve('no answer in 10 s');
        }, 10000);
        connection.onmessage = (text) => {
          const message = JSON.parse(text);
          if (message.id !== 1) return;
          clearTimeout(timer);
          connection.close();
          const info = message.result?.targetInfos?.find((one) => one.targetId === targetId);
          resolve(
            message.error?.message ?? (info ? { url: info.url, title: info.title } : 'not listed')
          );
        };
        connection.send(JSON.stringify({ id: 1, method: 'Target.getTargets', params: {} }));
      });
    }, targetId);
  }

  async function reach(base, targetId, mark) {
    const version = await httpJson(`${base}/json/version`);
    const list = await httpJson(`${base}/json/list`);
    const entry = Array.isArray(list.body) ? list.body.find((one) => one.id === targetId) : null;
    const socket = dial(version.body.webSocketDebuggerUrl);
    await socket.opened;
    try {
      const listed = await socket.call('Target.getTargets');
      const info = listed.result?.targetInfos?.find((one) => one.targetId === targetId);
      const attached = await socket.call('Target.attachToTarget', { targetId, flatten: true });
      const seen = {
        json: entry ? { url: entry.url, title: entry.title } : 'not listed',
        getTargets: info ? { url: info.url, title: info.title } : 'not listed',
        attach: attached.error?.message ?? 'attached',
      };
      const sessionId = attached.result?.sessionId;
      if (sessionId) {
        const enable = await socket.call('Runtime.enable', {}, sessionId);
        seen.enable = enable.error?.message ?? 'enabled';
        const read = await socket.call(
          'Runtime.evaluate',
          { expression: 'document.title + " " + document.body.innerText', returnByValue: true },
          sessionId
        );
        seen.read = read.error?.message ?? read.result?.result?.value;
      }
      seen.markReached = JSON.stringify(socket.messages()).includes(mark);
      return seen;
    } finally {
      socket.ws.close();
    }
  }

  async function clientsSee(base, origin, mark) {
    const out = {};
    try {
      const playwright = await step('playwright', `connect beside ${mark}`, () =>
        chromium.connectOverCDP(base)
      );
      try {
        const [context] = playwright.contexts();
        await until('the default page in the default context', () =>
          context.pages().find((page) => page.url() === `${rig.ordinary}/page`)
        );
        const pages = context.pages().filter((page) => page.url().startsWith(origin));
        out.playwright = pages.map((page) => page.url());
        out.playwrightTitles = [];
        for (const page of pages)
          out.playwrightTitles.push(
            await bounded(
              page.title().catch((error) => `error: ${error.message.slice(0, 200)}`),
              5000,
              'page.title()'
            )
          );
      } finally {
        await bounded(playwright.close(), 5000, 'close');
      }
    } catch (error) {
      out.playwright = `error: ${error.message.slice(0, 200)}`;
    }
    const { body } = await httpJson(`${base}/json/version`);
    const recorded = await recordedTransport(body.webSocketDebuggerUrl);
    try {
      const driven = await step('puppeteer', `connect beside ${mark}`, () =>
        puppeteer.connect({ transport: recorded.transport, protocolTimeout: STEP_MS })
      );
      try {
        out.puppeteerTargets = driven
          .targets()
          .map((target) => target.url())
          .filter((url) => url.startsWith(origin));
        out.puppeteerPages = await bounded(
          driven.pages().then(
            (pages) => pages.map((page) => page.url()).filter((url) => url.startsWith(origin)),
            (error) => `error: ${error.message.slice(0, 200)}`
          ),
          STEP_MS,
          'pages()'
        );
      } finally {
        await bounded(driven.disconnect(), 5000, 'disconnect');
      }
    } catch (error) {
      out.puppeteerTargets = `error: ${error.message.slice(0, 200)}`;
      out.puppeteerTrace = recorded.trace.slice(-40);
      recorded.transport.close();
    }
    return out;
  }

  const unreachable = (seen, what) => {
    const shown = JSON.stringify(seen);
    assert.equal(seen.json, 'not listed', `${what} in /json/list: ${shown}`);
    assert.equal(seen.getTargets, 'not listed', `${what} in Target.getTargets: ${shown}`);
    assert.notEqual(seen.attach, 'attached', `${what} attachable: ${shown}`);
    assert.equal(seen.markReached, false, `${what}'s content reached the client: ${shown}`);
    assert.deepEqual(seen.clients.playwright, [], `Playwright lists ${what}: ${shown}`);
    assert.deepEqual(seen.clients.puppeteerTargets, [], `Puppeteer targets ${what}: ${shown}`);
    assert.ok(Array.isArray(seen.clients.puppeteerPages), `Puppeteer pages() failed: ${shown}`);
    assert.deepEqual(seen.clients.puppeteerPages, [], `Puppeteer pages() has ${what}: ${shown}`);
  };

  async function signInTab(t, base, page, url) {
    const plain = await unguarded(rig.browserUrl);
    const asked = hits.get('idp.test/ims/authorize/v2') ?? 0;
    const { targetId } = await plain.send('Target.createTarget', { url, background: true });
    t.after(async () => {
      await plain.send('Target.closeTarget', { targetId }).catch(() => {});
      plain.close();
    });
    await until('the sign-in page', () => (hits.get('idp.test/ims/authorize/v2') ?? 0) > asked);
    const { targetInfos } = await plain.send('Target.getTargets');
    const seen = {
      chrome: targetInfos.find((info) => info.targetId === targetId)?.url,
      sliccLinkGuard: await sliccLayer(page, targetId),
      ...(await reach(base, targetId, SIGN_IN_MARK)),
    };
    process.stdout.write(`STOCK-SIGNIN ${label} ${JSON.stringify(seen)}\n`);
    seen.clients = await clientsSee(base, rig.idpOrigin, SIGN_IN_MARK);
    process.stdout.write(`STOCK-SIGNIN-CLIENTS ${label} ${JSON.stringify(seen.clients)}\n`);
    unreachable(seen, 'the sign-in tab');
  }

  async function signIns(t, base, page) {
    await t.test('seven’s own sign-in tab (its client id and callback) stays out of reach', (t) =>
      signInTab(t, base, page, rig.signIn)
    );
    await t.test('a sign-in tab that names only seven’s callback stays out of reach', (t) =>
      signInTab(t, base, page, rig.callbackOnly)
    );
    await t.test('a held sign-in tab moved to an ordinary page stays out of reach', async (t) => {
      const plain = await unguarded(rig.browserUrl);
      const marker = `stock${Math.random().toString(36).slice(2)}`;
      const held = await page.evaluate(async (marker) => {
        window.stockHeld = window.open(
          `about:blank#slicc-sign-in-${marker}`,
          'slicc-mcp-oauth',
          'popup,width=520,height=720'
        );
        const channel = new BroadcastChannel('slicc-held');
        const answer = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 8000);
          channel.onmessage = ({ data }) => {
            if (data?.marker !== marker || data.type === 'hold') return;
            clearTimeout(timer);
            resolve(data.type);
          };
          channel.postMessage({ type: 'hold', marker });
        });
        channel.close();
        return answer;
      }, marker);
      let heldId = null;
      t.after(async () => {
        await page.evaluate(() => window.stockHeld?.close()).catch(() => {});
        if (heldId) await plain.send('Target.closeTarget', { targetId: heldId }).catch(() => {});
        plain.close();
      });
      const heldUrl = `${rig.ordinary}/held`;
      await page.evaluate((url) => {
        window.stockHeld.location.href = url;
      }, heldUrl);
      const info = await until('the held sign-in tab on an ordinary page', async () => {
        const { targetInfos } = await plain.send('Target.getTargets');
        return targetInfos.find((one) => one.type === 'page' && one.url === heldUrl);
      });
      heldId = info.targetId;
      const seen = {
        hold: held,
        sliccLinkGuard: await sliccLayer(page, info.targetId),
        ...(await reach(base, info.targetId, HELD_MARK)),
      };
      process.stdout.write(`STOCK-HELD ${label} ${JSON.stringify(seen)}\n`);
      seen.clients = await clientsSee(base, heldUrl, HELD_MARK);
      process.stdout.write(`STOCK-HELD-CLIENTS ${label} ${JSON.stringify(seen.clients)}\n`);
      unreachable(seen, 'the held sign-in tab');
      assert.equal(held, 'held', `seven held its sign-in popup: ${JSON.stringify(seen)}`);
    });
  }

  async function routeHint(base) {
    const version = await httpJson(`${base}/json/version`);
    assert.equal(version.status, 200, version.text);
    const socket = dial(version.body.webSocketDebuggerUrl);
    await socket.opened;
    try {
      const answer = await socket.call('Browser.getVersion');
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.equal(
        answer.result?.slicc?.route,
        route,
        `the stream ends on the ${route} route: ${JSON.stringify(answer.result?.slicc)}`
      );
    } finally {
      socket.ws.close();
    }
  }

  async function live(base) {
    const playwright = await step('playwright', 'live connect', () =>
      chromium.connectOverCDP(base)
    );
    const playwrightGone = new Promise((resolve) => playwright.once('disconnected', resolve));
    const { body } = await httpJson(`${base}/json/version`);
    const recorded = await recordedTransport(body.webSocketDebuggerUrl);
    const driven = await step('puppeteer', 'live connect', () =>
      puppeteer.connect({ transport: recorded.transport, protocolTimeout: STEP_MS })
    );
    const puppeteerGone = new Promise((resolve) => driven.once('disconnected', resolve));
    assert.ok((await playwright.version()).length > 0);
    assert.ok((await driven.version()).length > 0);
    return { playwright, playwrightGone, driven, puppeteerGone, closed: recorded.closed };
  }

  async function chip(page) {
    const shown = await items(page);
    assert.ok(
      shown.some(
        (item) =>
          item.kind === 'cdp' &&
          item.label === 'Driving this browser' &&
          item.action?.label === 'Stop' &&
          typeof item.asker === 'string' &&
          item.asker.length > 0
      ),
      `the chip shows while connected: ${JSON.stringify(shown)}`
    );
    return shown.find((item) => item.kind === 'cdp');
  }

  function report(t) {
    t.after(() => {
      console.log(`STOCK-HOLDS ${label} ${JSON.stringify(holds.splice(0))}`);
      console.log(`STOCK-STEPS ${label} ${JSON.stringify(steps.splice(0))}`);
    });
  }

  async function overTray(t) {
    t.diagnostic(`@ai-ecoverse/slicc pin ${PIN}`);
    await start();
    report(t);
    const hub = await startHub();
    t.after(() => hub.close());
    const page = await seven(t);
    await boot(page, undefined, { tools: false });
    await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
    await page.reload();
    await ready(page, undefined, { tools: false });
    if (route === 'link') await linkSeven(t, page);
    const joinUrl = await page.within(
      60000,
      () => document.querySelector('slicc-app').model.network.status().links?.joinUrl
    );
    assert.equal(joinUrl, `${hub.url}/join/j1`);
    await seed(t);
    const env = await scratch(t, 'remote-cdp-stock-');

    const denied = startCdp(t, [joinUrl, 'cdp', '--port', '0', '--json'], { env });
    const deniedExit = await within(denied.exited, 120000, 'slicc cdp exit without Browser grant');
    assert.equal(deniedExit.code, 3, denied.stderr.join(''));
    assert.match(denied.stderr.join(''), escaped(NO_GRANT));
    assert.equal(
      denied.events.some((event) => event.event === 'listening'),
      false
    );

    const device = await page.within(60000, () => {
      const rows = document.querySelector('slicc-app').model.network.status().links?.devices ?? [];
      return rows.find((row) => row.kind === 'cli' && row.mode === 'remote')?.id;
    });
    assert.match(device, /^[0-9a-f]{64}$/);
    await model(page, (network, id) => network.setAccess(id, 'browser', true), device);
    assert.deepEqual(
      (
        await model(
          page,
          (network, id) => network.status().links.devices.find((row) => row.id === id),
          device
        )
      ).access,
      { control: false, browser: true }
    );

    const run = startCdp(t, [joinUrl, 'cdp', '--port', '0', '--json'], { env });
    const base = await waitListening(run);
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    await routeHint(base);

    await t.test('Playwright', () => playwrightFlow(base));
    await t.test('Puppeteer', () => puppeteerFlow(base));
    await signIns(t, base, page);

    await t.test('the switch closes live Playwright and Puppeteer sessions', async () => {
      const sessions = await live(base);
      await chip(page);
      await setSwitch(page, false);
      const closed = await within(
        sessions.closed,
        30000,
        'Puppeteer socket close after the switch'
      );
      assert.equal(closed.code, 1008, JSON.stringify(closed));
      assert.equal(closed.reason, SWITCHED_OFF);
      await within(sessions.puppeteerGone, 30000, 'Puppeteer disconnected after the switch');
      await within(sessions.playwrightGone, 30000, 'Playwright disconnected after the switch');
      assert.deepEqual(await items(page), []);
      await setSwitch(page, true);
    });

    await t.test('Stop on the chip closes live Playwright and Puppeteer sessions', async () => {
      const sessions = await live(base);
      const shown = await chip(page);
      await stopChip(page, shown.id);
      const closed = await within(sessions.closed, 30000, 'Puppeteer socket close after Stop');
      assert.match(closed.reason, escaped(STOPPED), JSON.stringify(closed));
      process.stdout.write(`STOCK-STOP ${label} ${JSON.stringify(closed)}\n`);
      await within(sessions.puppeteerGone, 30000, 'Puppeteer disconnected after Stop');
      await within(sessions.playwrightGone, 30000, 'Playwright disconnected after Stop');
      assert.deepEqual(await items(page), []);
    });
  }

  async function overStdio(t) {
    t.diagnostic(`@ai-ecoverse/slicc pin ${PIN}`);
    await start();
    report(t);
    const page = await seven(t);
    await boot(page, undefined, { tools: false });
    await seed(t);
    let current = null;
    await page.expose('sliccLinkSend', (message) =>
      current?.node.stdin.write(`${JSON.stringify(message)}\n`)
    );
    const env = await scratch(t, 'remote-cdp-stock-');
    const run = startCdp(t, ['cdp', '--signal', 'stdio', '--port', '0', '--json'], {
      env,
      page,
    });
    current = run;
    const base = await waitListening(run);
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    await routeHint(base);
    await t.test('Playwright', () => playwrightFlow(base));
    await t.test('Puppeteer', () => puppeteerFlow(base));
    await signIns(t, base, page);
    await t.test('the chip shows while a live session is connected', async () => {
      const sessions = await live(base);
      await chip(page);
      await sessions.playwright.close();
      await sessions.driven.disconnect();
    });
  }

  const title =
    chain === 'stdio'
      ? `stock Playwright and Puppeteer through released slicc cdp --signal stdio on the ${route} route drive an ordinary page and stay out of seven, the vault and a held sign-in`
      : `stock Playwright and Puppeteer through released slicc <join-url> cdp and the fake tray on the ${route} route need Browser, drive an ordinary page, stay out of seven, the vault and a held sign-in, and close on the switch and Stop`;
  test(title, { skip: !CLI, timeout: 25 * 60 * 1000 }, (t) =>
    chain === 'stdio' ? overStdio(t) : overTray(t)
  );
}
