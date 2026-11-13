import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import { boot } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { linkNode } from './linked-node.mjs';

const RELAY = 'https://www.sliccy.ai/auth/callback';
const MARK = 'LINK-SIGN-IN-BODY';
const HELD_MARK = 'LINK-HELD-BODY';
const UNHELD =
  "Seven couldn't keep the sign-in window out of reach of browser automation, so it didn't open the sign-in. Try again.";
const hits = new Map();
const site = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const hit = `${url.hostname}${url.pathname}`;
  hits.set(hit, (hits.get(hit) ?? 0) + 1);
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/ims/authorize/v2')
    return res.end(`<!doctype html><title>${MARK}-title</title><h1>${MARK}</h1>`);
  if (url.pathname.startsWith('/held'))
    return res.end(`<!doctype html><title>${HELD_MARK}-title</title><h1>${HELD_MARK}</h1>`);
  res.end(`<!doctype html><title>plain ${url.pathname}</title><h1>plain</h1>`);
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const port = site.address().port;
const CALLBACK_ONLY = `http://idp.test:${port}/ims/authorize/v2?client_id=any&redirect_uri=${encodeURIComponent(RELAY)}&response_type=token`;
const ORDINARY_ORIGIN = `http://ordinary.test:${port}`;
const ORDINARY = `${ORDINARY_ORIGIN}/page`;

const certs = mkdtempSync(join(tmpdir(), 'slicc-sign-in-link-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=ims-na1.adobelogin.com',
    '-keyout',
    join(certs, 'key.pem'),
    '-out',
    join(certs, 'cert.pem'),
  ],
  { stdio: 'ignore' }
);
const ims = createHttps(
  { key: readFileSync(join(certs, 'key.pem')), cert: readFileSync(join(certs, 'cert.pem')) },
  (req, res) => {
    const url = new URL(req.url, 'https://ims-na1.adobelogin.com');
    if (url.pathname === '/ims/authorize/v2') {
      res.writeHead(302, { location: `/landing?child=1#access_token=${HELD_MARK}-idp` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${HELD_MARK} ${url.pathname}</title><h1>${HELD_MARK}</h1><script>
if (new URLSearchParams(location.search).get('child')) window.open('/idp-child#access_token=${HELD_MARK}-child', 'idp-child', 'popup');
</script>`);
  }
);
await new Promise((resolve) => ims.listen(0, '127.0.0.1', resolve));

const chrome = await launch({
  tools: false,
  args: [
    `--host-resolver-rules=MAP idp.test 127.0.0.1, MAP ordinary.test 127.0.0.1, MAP ims-na1.adobelogin.com:443 127.0.0.1:${ims.address().port}`,
    '--ignore-certificate-errors',
    '--disable-popup-blocking',
  ],
});
const { port: debugging } = await devtools(chrome);
const browserUrl = await debuggerUrl(debugging);
const SEVEN_ORIGIN = new URL(chrome.url).origin;
after(() => {
  chrome.close();
  site.close();
  ims.close();
  rmSync(certs, { recursive: true, force: true });
});

const listed = () => fetch(`http://127.0.0.1:${debugging}/json/list`).then((r) => r.json());

async function waitFor(name, found, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await found();
    if (value) return value;
    if (Date.now() > end) throw new Error(`no ${name} in ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function debugSignIn() {
  globalThis.sliccKernelDebug = true;
  globalThis.sliccLoginDebug = true;
  localStorage.setItem('slicc-os.sign-in', 'relay');
}

async function sevenOnDevtools(t) {
  const page = await chrome.page(t);
  await page.init(debugSignIn);
  await page.init(
    `() => Object.defineProperty(globalThis, 'crestDevTools', { configurable: true, value: Object.freeze({ webSocketDebuggerUrl: ${JSON.stringify(browserUrl)} }) })`
  );
  await boot(page, undefined, { tools: false });
  return page;
}

async function sevenOverLink(t) {
  const page = await chrome.page(t);
  await page.init(debugSignIn);
  await boot(page, undefined, { tools: false });
  await linkNode(t, page, debugging, 'seven-browser', { seven: true, origins: [SEVEN_ORIGIN] });
  const linked = await page.evaluate(() =>
    globalThis.sliccLinkedBrowsers().map(({ seven, local }) => ({ seven, local }))
  );
  assert.ok(
    linked.some((browser) => browser.seven && browser.local),
    `a local seven browser on the link: ${JSON.stringify(linked)}`
  );
  return page;
}

async function guarded(page, name) {
  await page.evaluate(async (name) => {
    const connection = await globalThis.sliccBrowserHook({
      caller: { kind: 'device', id: name, name },
    });
    const pending = new Map();
    const messages = [];
    let next = 0;
    connection.onmessage = (text) => {
      messages.push(text);
      const message = JSON.parse(text);
      if (message.id === undefined) return;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    };
    window.agents ??= {};
    window.agents[name] = {
      messages,
      close: () => connection.close(),
      send: (method, params = {}, sessionId) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer in 20 s` } });
          }, 20000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
          );
        }),
    };
  }, name);
  const send = (method, params, sessionId) =>
    page.evaluate(
      ([n, m, p, s]) => window.agents[n].send(m, p, s),
      [name, method, params, sessionId]
    );
  const seen = () => page.evaluate((n) => window.agents[n].messages.join('\n'), name);
  return { send, seen, close: () => page.evaluate((n) => window.agents[n].close(), name) };
}

async function reach(agent, targetId) {
  const { result } = await agent.send('Target.getTargets');
  const attached = await agent.send('Target.attachToTarget', { targetId, flatten: true });
  const seen = {
    listed: (result?.targetInfos ?? []).some((info) => info.targetId === targetId),
    info: (await agent.send('Target.getTargetInfo', { targetId })).error?.message ?? 'answered',
    attach: attached.error?.message ?? 'attached',
  };
  const sessionId = attached.result?.sessionId;
  if (sessionId) {
    const read = await agent.send(
      'Runtime.evaluate',
      { expression: 'document.title + " " + document.body.innerText', returnByValue: true },
      sessionId
    );
    seen.read = read.error?.message ?? read.result?.result?.value;
    await agent.send('Target.detachFromTarget', { sessionId });
  }
  return seen;
}

async function onRoute(agent, route) {
  const version = await agent.send('Browser.getVersion');
  assert.equal(version.result?.slicc?.route, route, JSON.stringify(version));
}

async function rawTab(t, url) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url, background: true });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  await waitFor(url, async () =>
    (await listed()).some((tab) => tab.id === targetId && tab.url === url)
  );
  return targetId;
}

test('through a linked seven browser, a sign-in tab that names only seven’s callback is not listed, attached or read, though slicc-cli cuts the callback to its origin', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await sevenOverLink(t);
  const asked = hits.get('idp.test/ims/authorize/v2') ?? 0;
  const signIn = await rawTab(t, CALLBACK_ONLY);
  assert.ok((hits.get('idp.test/ims/authorize/v2') ?? 0) > asked, 'the sign-in page loaded');
  const plain = await rawTab(t, ORDINARY);
  const agent = await guarded(page, 'callback-only');
  t.after(() => agent.close().catch(() => {}));
  await onRoute(agent, 'link');
  const seen = await reach(agent, signIn);
  assert.equal(seen.listed, false, `the sign-in tab is listed: ${JSON.stringify(seen)}`);
  assert.match(seen.info, /^slicc: refused:/, JSON.stringify(seen));
  assert.match(seen.attach, /^slicc: refused:/, JSON.stringify(seen));
  assert.ok(
    !(await agent.seen()).includes(MARK),
    `the sign-in page reached the client: ${JSON.stringify(seen)}`
  );
  const ordinary = await reach(agent, plain);
  assert.equal(ordinary.listed, true, JSON.stringify(ordinary));
  assert.equal(ordinary.read, 'plain /page plain', JSON.stringify(ordinary));
});

async function unreachable(agent, ids) {
  for (const [name, targetId] of Object.entries(ids)) {
    const seen = await reach(agent, targetId);
    assert.equal(seen.listed, false, `${name} is listed: ${JSON.stringify(seen)}`);
    assert.match(seen.info, /^slicc: refused:/, `${name}: ${JSON.stringify(seen)}`);
    assert.match(seen.attach, /^slicc: refused:/, `${name}: ${JSON.stringify(seen)}`);
  }
  assert.ok(!(await agent.seen()).includes(HELD_MARK), 'a held page reached the client');
}

async function tabWhere(page, name, match) {
  return waitFor(name, async () => {
    const answer = await page.evaluate(() => window.signInAnswer);
    if (answer) throw new Error(`the sign-in ended before ${name}: ${answer}`);
    return (await listed()).find(match)?.id;
  });
}

async function navigate(targetId, url) {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await chrome.cdp.send('Page.navigate', { url }, sessionId);
  await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  await waitFor(url, async () =>
    (await listed()).some((tab) => tab.id === targetId && tab.url === url)
  );
}

function startSignIn(page) {
  return page.evaluate(() => {
    window.signInAnswer = null;
    void globalThis
      .sliccLogin('adobe', async () => ({ clientId: 'test-client', scopes: 'openid' }))
      .then(
        (token) => `resolved ${typeof token}`,
        (error) => error.message
      )
      .then((answer) => {
        window.signInAnswer = answer;
      });
  });
}

test('through only a linked seven browser, seven’s sign-in window and the IdP’s popup are held, and stay out of reach on an ordinary page', {
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const page = await sevenOverLink(t);
  const plain = await rawTab(t, ORDINARY);
  const before = new Set((await listed()).map((tab) => tab.id));
  await startSignIn(page);
  const popup = await tabWhere(
    page,
    'the sign-in window at the IdP',
    (tab) => !before.has(tab.id) && tab.url.startsWith('https://ims-na1.adobelogin.com/landing')
  );
  const child = await tabWhere(page, 'the IdP’s popup', (tab) =>
    tab.url.startsWith('https://ims-na1.adobelogin.com/idp-child')
  );
  t.after(() =>
    Promise.all(
      [popup, child].map((targetId) =>
        chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {})
      )
    )
  );
  assert.equal(await page.evaluate(() => window.signInAnswer), null);
  const agent = await guarded(page, 'held-link');
  t.after(() => agent.close().catch(() => {}));
  await onRoute(agent, 'link');
  await unreachable(agent, { 'the sign-in window': popup, 'the IdP’s popup': child });
  await navigate(popup, `${ORDINARY_ORIGIN}/held-elsewhere#access_token=${HELD_MARK}-elsewhere`);
  await navigate(child, `${ORDINARY_ORIGIN}/held-child#access_token=${HELD_MARK}-child-elsewhere`);
  const late = await guarded(page, 'held-link-late');
  t.after(() => late.close().catch(() => {}));
  for (const each of [agent, late])
    await unreachable(each, {
      'the sign-in window on an ordinary page': popup,
      'the IdP’s popup on an ordinary page': child,
    });
  const ordinary = await reach(late, plain);
  assert.equal(ordinary.read, 'plain /page plain', JSON.stringify(ordinary));
  assert.notEqual(await page.evaluate(() => window.signInAnswer), UNHELD);
});

async function heldTab(t, page) {
  const marker = `g5${Math.random().toString(36).slice(2)}`;
  const before = new Set((await listed()).map((tab) => tab.id));
  const held = await page.evaluate(async (marker) => {
    window.heldTab = window.open(
      `about:blank#slicc-sign-in-${marker}`,
      'slicc-mcp-oauth',
      'popup,width=520,height=720'
    );
    const channel = new BroadcastChannel('slicc-held');
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('no answer in 8 s'), 8000);
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
  assert.equal(held, 'held');
  const url = `${ORDINARY_ORIGIN}/held-${marker}`;
  await page.evaluate((url) => {
    window.heldTab.location.href = url;
  }, url);
  const targetId = await waitFor(
    'the held tab on an ordinary page',
    async () => (await listed()).find((tab) => !before.has(tab.id) && tab.url === url)?.id
  );
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  return { targetId, url };
}

async function bridge(t, page) {
  const sockets = new Map();
  await page.expose('bridgeOut', ({ id, text, closed }) => {
    const socket = sockets.get(id);
    if (!socket) return;
    if (closed !== undefined) socket.close(1011, closed.slice(0, 120));
    else if (socket.readyState === 1) socket.send(text);
  });
  await page.evaluate(() => {
    window.bridged = new Map();
    window.bridgeOpen = async (id) => {
      try {
        const connection = await globalThis.sliccBrowserHook({
          caller: { kind: 'device', id: 'puppeteer', name: 'puppeteer' },
        });
        connection.onmessage = (text) => window.bridgeOut(JSON.stringify({ id, text }));
        connection.onclose = (reason) =>
          window.bridgeOut(JSON.stringify({ id, closed: String(reason ?? '') }));
        window.bridged.set(id, connection);
        return true;
      } catch (error) {
        return String(error?.message ?? error);
      }
    };
    window.bridgeSend = (id, text) => {
      window.bridged.get(id)?.send(text);
      return true;
    };
    window.bridgeClose = (id) => {
      window.bridged.get(id)?.close();
      window.bridged.delete(id);
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
  wss.on('connection', (socket) => {
    ids += 1;
    const id = ids;
    sockets.set(id, socket);
    let chain = page
      .evaluate((id) => window.bridgeOpen(id), id)
      .then((opened) => {
        if (opened !== true) socket.close(1011, String(opened).slice(0, 120));
      });
    socket.on('message', (data) => {
      const text = data.toString();
      chain = chain
        .then(() => page.evaluate((id, text) => window.bridgeSend(id, text), id, text))
        .catch(() => {});
    });
    socket.on('close', () => {
      sockets.delete(id);
      chain = chain.then(() => page.evaluate((id) => window.bridgeClose(id), id)).catch(() => {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of wss.clients) socket.terminate();
    server.close();
  });
  return `ws://127.0.0.1:${server.address().port}/devtools/browser/bridge`;
}

const bounded = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

for (const [route, open] of [
  ['link', sevenOverLink],
  ['devtools', sevenOnDevtools],
])
  test(`on the ${route} route, stock Puppeteer connects while a held sign-in tab is open, and never sees it`, {
    timeout: 5 * 60 * 1000,
  }, async (t) => {
    const page = await open(t);
    const held = await heldTab(t, page);
    const agent = await guarded(page, `held-${route}`);
    t.after(() => agent.close().catch(() => {}));
    await onRoute(agent, route);
    await unreachable(agent, { 'the held tab on an ordinary page': held.targetId });
    const endpoint = await bridge(t, page);
    const driven = await bounded(
      puppeteer.connect({ browserWSEndpoint: endpoint, protocolTimeout: 30000 }),
      30000,
      `puppeteer.connect beside a held tab on the ${route} route`
    );
    try {
      const targets = driven.targets().map((target) => target.url());
      assert.ok(
        !targets.includes(held.url),
        `Puppeteer lists the held tab: ${JSON.stringify(targets)}`
      );
      const pages = await bounded(driven.pages(), 30000, 'pages()');
      assert.ok(!pages.some((one) => one.url() === held.url), 'Puppeteer pages() has the held tab');
      const fresh = await bounded(driven.newPage(), 30000, 'newPage()');
      await bounded(fresh.goto(ORDINARY), 30000, 'goto');
      assert.equal(await fresh.title(), 'plain /page');
      await fresh.close();
    } finally {
      await bounded(driven.disconnect(), 10000, 'disconnect').catch(() => {});
    }
  });
