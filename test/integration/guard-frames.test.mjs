import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { ready } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const site = createHttp((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/plain') {
    return res.end('<title>plain</title><h1>plain</h1>');
  }
  if (url.pathname === '/inner') {
    return res.end('<title>inner</title><p id="inner">INNER-OK</p>');
  }
  if (url.pathname === '/parent') {
    return res.end(
      `<title>parent</title><h1>ordinary</h1><iframe id="child" src="http://vault.sliccy.ai:${port}/child"></iframe>`
    );
  }
  return res.end('<title>VAULT-FRAME</title><input id="secret" value="FRAME-MARK">');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const port = site.address().port;
after(() => site.close());

const debugging = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const chrome = await launch({
  args: [
    `--remote-debugging-port=${debugging}`,
    '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1, MAP ordinary.test 127.0.0.1',
    '--disable-site-isolation-trials',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
});
after(() => chrome.close());
const fakeExtension = extensionOver(await debuggerUrl(debugging));

async function framed() {
  const { targetId } = await chrome.cdp.send('Target.createTarget', {
    url: `http://ordinary.test:${port}/parent`,
  });
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const deadline = Date.now() + 15000;
  for (;;) {
    const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, sessionId);
    const child = frameTree.childFrames?.[0]?.frame;
    if (child?.url?.includes('vault.sliccy.ai')) {
      const { targetInfos } = await chrome.cdp.send('Target.getTargets');
      await chrome.cdp.send('Target.detachFromTarget', { sessionId });
      return {
        targetId,
        frameId: child.id,
        sameProcess: !targetInfos.some((info) => info.targetId === child.id),
      };
    }
    if (Date.now() > deadline)
      throw new Error(`the vault child frame never committed: ${JSON.stringify(frameTree)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function reads({ transport, proxy, targetId, frameId }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { proxyHost, extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const raw =
    transport === 'proxy'
      ? await proxyHost(proxy)()
      : extensionConnection(globalThis.sliccExtension.cdp);
  const connection = guardProtected(raw, self.origin);
  const pending = new Map();
  const seen = [];
  let next = 0;
  connection.onmessage = (text) => {
    seen.push(text);
    const message = JSON.parse(text);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      const timer = setTimeout(
        () => resolve({ error: { message: `${method} got no answer` } }),
        10000
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const out = {};
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  out.attach = attached.error?.message ?? 'attached';
  const session = attached.result?.sessionId;
  const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'probe' }, session);
  const contextId = world.result?.executionContextId;
  const calls = {
    'Accessibility.getFullAXTree': ['Accessibility.getFullAXTree', { frameId }],
    'DOM.getDocument': ['DOM.getDocument', { depth: -1, pierce: true }],
    'DOM.describeNode': ['DOM.describeNode', { backendNodeId: 1, depth: -1, pierce: true }],
    'DOMSnapshot.captureSnapshot': ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
    'Page.getResourceContent': [
      'Page.getResourceContent',
      { frameId, url: `http://vault.sliccy.ai:${new URL(location.href).port}/child` },
    ],
    'Page.createIsolatedWorld': null,
    'Runtime.evaluate in that world': [
      'Runtime.evaluate',
      { expression: 'document.getElementById("secret")?.value', contextId, returnByValue: true },
    ],
  };
  out['Page.createIsolatedWorld'] = world.error?.message ?? 'answered';
  for (const [name, call] of Object.entries(calls)) {
    if (!call) continue;
    const answer = await send(call[0], call[1], session);
    out[name] = answer.error?.message ?? 'answered';
  }
  out.leaked = seen.some((text) => text.includes('FRAME-MARK') || text.includes('VAULT-FRAME'));
  connection.close?.();
  return out;
}

async function check(t, transport) {
  const page = await chrome.page(t);
  let proxy;
  if (transport === 'proxy') {
    proxy = await startProxy({
      port: 0,
      origins: [new URL(chrome.url).origin],
      cdp: `http://127.0.0.1:${debugging}`,
      kernelPort: null,
      log: () => {},
    });
    t.after(() => proxy.close());
  } else {
    const extension = await fakeExtension(page);
    t.after(() => extension.close());
  }
  await page.goto(proxy ? `/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}` : '/');
  await ready(page);
  const { targetId, frameId, sameProcess } = await framed();
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  assert.equal(sameProcess, true, 'the vault child frame shares its parent’s process');
  const out = await page.evaluate(reads, {
    transport,
    proxy: proxy && { url: proxy.url, key: proxy.key },
    targetId,
    frameId,
  });
  assert.equal(out.leaked, false, JSON.stringify(out));
  assert.match(out.attach, /^slicc: refused:/, 'the tab holding the vault frame is refused whole');
  for (const [name, answer] of Object.entries(out)) {
    if (name === 'leaked' || name === 'attach') continue;
    assert.notEqual(answer, 'answered', `${name} with the vault frame's id is never answered`);
  }
}

test(
  'a tab with a same-process vault frame that committed before the client attached is refused whole, on the proxy path',
  { timeout: 3 * 60 * 1000 },
  (t) => check(t, 'proxy')
);

test(
  'a tab with a same-process vault frame that committed before the client attached is refused whole, on the extension path',
  { timeout: 3 * 60 * 1000 },
  (t) => check(t, 'extension')
);

async function fresh({ transport, proxy, port }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { proxyHost, extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const raw =
    transport === 'proxy'
      ? await proxyHost(proxy)()
      : extensionConnection(globalThis.sliccExtension.cdp);
  const connection = guardProtected(raw, self.origin);
  const pending = new Map();
  const events = [];
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id === undefined) events.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      const timer = setTimeout(
        () => resolve({ error: { message: `${method} got no answer` } }),
        10000
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const until = async (check) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  const created = await send('Target.createTarget', { url: `http://ordinary.test:${port}/plain` });
  const targetId = created.result?.targetId;
  const session = (await send('Target.attachToTarget', { targetId, flatten: true })).result
    ?.sessionId;
  await send('Page.enable', {}, session);
  await until(async () =>
    (await send('Page.getFrameTree', {}, session)).result?.frameTree?.frame?.url?.endsWith('/plain')
  );
  const out = {};
  out.unknown =
    (
      await send(
        'Page.createIsolatedWorld',
        { frameId: 'F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0', worldName: 'x' },
        session
      )
    ).error?.message ?? 'answered';
  await send(
    'Runtime.evaluate',
    {
      expression: `const f=document.createElement('iframe');f.src='/inner';document.body.append(f);void 0`,
    },
    session
  );
  out.attached = await until(() => events.some((event) => event.method === 'Page.frameAttached'));
  out.navigated = await until(() =>
    events.some((event) => event.method === 'Page.frameNavigated' && event.params.frame.parentId)
  );
  const child = events.find(
    (event) => event.method === 'Page.frameNavigated' && event.params.frame.parentId
  )?.params.frame.id;
  const world = await send(
    'Page.createIsolatedWorld',
    { frameId: child, worldName: 'probe' },
    session
  );
  out.world = world.error?.message ?? 'answered';
  const read = await send(
    'Runtime.evaluate',
    {
      expression: 'document.getElementById("inner")?.textContent',
      contextId: world.result?.executionContextId,
      returnByValue: true,
    },
    session
  );
  out.read = read.result?.result?.value ?? read.error?.message ?? null;
  await send('Target.closeTarget', { targetId });
  return out;
}

async function freshCheck(t, transport) {
  const page = await chrome.page(t);
  let proxy;
  if (transport === 'proxy') {
    proxy = await startProxy({
      port: 0,
      origins: [new URL(chrome.url).origin],
      cdp: `http://127.0.0.1:${debugging}`,
      kernelPort: null,
      log: () => {},
    });
    t.after(() => proxy.close());
  } else {
    const extension = await fakeExtension(page);
    t.after(() => extension.close());
  }
  await page.goto(proxy ? `/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}` : '/');
  await ready(page);
  const out = await page.evaluate(fresh, {
    transport,
    proxy: proxy && { url: proxy.url, key: proxy.key },
    port,
  });
  assert.match(out.unknown, /^slicc: refused:/, 'a frame id the guard never saw is refused');
  assert.deepEqual(
    { attached: out.attached, navigated: out.navigated, world: out.world, read: out.read },
    { attached: true, navigated: true, world: 'answered', read: 'INNER-OK' },
    'a new frame that commits an ordinary document is readable'
  );
}

test(
  'a frame id the guard never saw is refused, and a new ordinary frame is readable once it commits, on the proxy path',
  { timeout: 3 * 60 * 1000 },
  (t) => freshCheck(t, 'proxy')
);

test(
  'a frame id the guard never saw is refused, and a new ordinary frame is readable once it commits, on the extension path',
  { timeout: 3 * 60 * 1000 },
  (t) => freshCheck(t, 'extension')
);
