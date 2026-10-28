import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const site = createHttp((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/plain') {
    return res.end('<title>plain</title><h1>plain</h1>');
  }
  if (url.pathname === '/linking') {
    return res.end(
      `<title>linking</title><p>see http://vault.sliccy.ai:${port}/oauth/mcp-callback?code=AXMARK1 here</p><a href="http://vault.sliccy.ai:${port}/oauth/mcp-callback?code=AXMARK3">vault</a>`
    );
  }
  if (url.pathname === '/editors') {
    return res.end(
      `<title>editors</title><iframe id="blank"></iframe><iframe id="srcdoc" srcdoc="<body contenteditable></body>"></iframe><script>const d=document.getElementById('blank').contentDocument;d.open();d.write('<body contenteditable></body>');d.close();</script>`
    );
  }
  if (url.pathname === '/late') {
    return res.end(
      `<title>late</title><script>window.go=()=>{const f=document.createElement('iframe');f.src='http://vault.sliccy.ai:${port}/child';document.body.append(f);return 'going'}</script>`
    );
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

const chrome = await launch({
  tools: false,
  args: [
    '--host-resolver-rules=MAP vault.sliccy.ai 127.0.0.1, MAP ordinary.test 127.0.0.1',
    '--disable-site-isolation-trials',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
});
const { port: debugging } = await devtools(chrome);
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

async function reads({ targetId, frameId, plain, vaultChild }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const connection = guardProtected(
    extensionConnection(globalThis.sliccExtension.cdp),
    self.origin
  );
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
  const created = await send('Target.createTarget', { url: plain });
  const granted = await send('Target.attachToTarget', {
    targetId: created.result?.targetId,
    flatten: true,
  });
  const session = granted.result?.sessionId;
  out.granted = Boolean(session);
  const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'probe' }, session);
  const contextId = world.result?.executionContextId;
  const calls = {
    'Accessibility.getFullAXTree': ['Accessibility.getFullAXTree', { frameId }],
    'DOM.getDocument': ['DOM.getDocument', { depth: -1, pierce: true }],
    'DOM.describeNode': ['DOM.describeNode', { backendNodeId: 1, depth: -1, pierce: true }],
    'DOMSnapshot.captureSnapshot': ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
    'Page.getResourceContent': ['Page.getResourceContent', { frameId, url: vaultChild }],
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
  await send('Target.closeTarget', { targetId: created.result?.targetId });
  connection.close?.();
  return out;
}

async function check(t) {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  const { targetId, frameId, sameProcess } = await framed();
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  assert.equal(sameProcess, true, 'the vault child frame shares its parent’s process');
  const out = await page.evaluate(reads, {
    targetId,
    frameId,
    plain: `http://ordinary.test:${port}/plain`,
    vaultChild: `http://vault.sliccy.ai:${port}/child`,
  });
  assert.equal(out.leaked, false, JSON.stringify(out));
  assert.match(out.attach, /^slicc: refused:/, 'the tab holding the vault frame is refused whole');
  assert.equal(
    out.granted,
    true,
    'an ordinary tab is attached, so its session carries the frame-scoped reads'
  );
  for (const name of [
    'Accessibility.getFullAXTree',
    'Page.getResourceContent',
    'Page.createIsolatedWorld',
  ]) {
    assert.match(out[name], /^slicc: refused:/, `${name} with the vault frame's id: ${out[name]}`);
  }
}

test(
  'a tab with a same-process vault frame that committed before the client attached is refused whole, on the extension path',
  { timeout: 3 * 60 * 1000 },
  (t) => check(t)
);

async function fresh({ port }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const connection = guardProtected(
    extensionConnection(globalThis.sliccExtension.cdp),
    self.origin
  );
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
  const until = async (check, what, saw) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${what} never happened; saw ${JSON.stringify(await saw()).slice(0, 400)}`);
  };
  const heard = () => events.map((event) => event.method);
  const created = await send('Target.createTarget', { url: `http://ordinary.test:${port}/plain` });
  const targetId = created.result?.targetId;
  const session = (await send('Target.attachToTarget', { targetId, flatten: true })).result
    ?.sessionId;
  await send('Page.enable', {}, session);
  const tree = async () => (await send('Page.getFrameTree', {}, session)).result?.frameTree;
  await until(
    async () => (await tree())?.frame?.url?.endsWith('/plain'),
    'the tab committing /plain',
    tree
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
  out.attached = await until(
    () => events.some((event) => event.method === 'Page.frameAttached'),
    'Page.frameAttached for the new iframe',
    heard
  );
  out.navigated = await until(
    () =>
      events.some((event) => event.method === 'Page.frameNavigated' && event.params.frame.parentId),
    'Page.frameNavigated for the new iframe',
    heard
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

async function freshCheck(t) {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  const out = await page.evaluate(fresh, {
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
  'a frame id the guard never saw is refused, and a new ordinary frame is readable once it commits, on the extension path',
  { timeout: 3 * 60 * 1000 },
  (t) => freshCheck(t)
);

async function late({ port, targetId }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const connection = guardProtected(
    extensionConnection(globalThis.sliccExtension.cdp),
    self.origin
  );
  const pending = new Map();
  const seen = [];
  const out = { early: {}, after: {} };
  let next = 0;
  let session;
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
  const reads = (frameId) => ({
    'Accessibility.getFullAXTree': ['Accessibility.getFullAXTree', { frameId }],
    'Page.createIsolatedWorld': [
      'Page.createIsolatedWorld',
      { frameId, worldName: 'w', grantUniveralAccess: true },
    ],
    'Page.getResourceContent': [
      'Page.getResourceContent',
      { frameId, url: `http://vault.sliccy.ai:${port}/child` },
    ],
  });
  let attached;
  const early = new Promise((resolve) => {
    attached = resolve;
  });
  connection.onmessage = (text) => {
    seen.push(text);
    const message = JSON.parse(text);
    if (message.method === 'Page.frameAttached' && message.params.parentFrameId) {
      const frameId = message.params.frameId;
      void Promise.all(
        Object.entries(reads(frameId)).map(async ([name, [method, params]]) => {
          const answer = await send(method, params, session);
          out.early[name] = answer.error?.message ?? 'answered';
        })
      ).then(() => attached(frameId));
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  session = (await send('Target.attachToTarget', { targetId, flatten: true })).result?.sessionId;
  out.granted = Boolean(session);
  await send('Page.enable', {}, session);
  out.go = (
    await send('Runtime.evaluate', { expression: 'go()', returnByValue: true }, session)
  ).result?.result?.value;
  const frameId = await Promise.race([
    early,
    new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
  ]);
  out.frameAttached = Boolean(frameId);
  if (!frameId) {
    out.events = seen.map((text) => JSON.parse(text).method).filter(Boolean);
    return out;
  }
  out.targetId = targetId;
  window.lateRig = async (frameTarget) => {
    if (frameTarget) {
      const own = await send('Target.attachToTarget', { targetId: frameTarget, flatten: true });
      out.frameTarget = own.error?.message ?? 'attached';
    }
    const after = {
      ...reads(frameId),
      'DOM.getDocument': ['DOM.getDocument', { depth: -1, pierce: true }],
      'DOMSnapshot.captureSnapshot': ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
    };
    for (const [name, [method, params]] of Object.entries(after)) {
      const answer = await send(method, params, session);
      out.after[name] = answer.error?.message ?? 'answered';
    }
    out.leaked = seen.some((text) => text.includes('FRAME-MARK') || text.includes('VAULT-FRAME'));
    await send('Target.closeTarget', { targetId });
    return out;
  };
  return out;
}

async function committed(targetId) {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const deadline = Date.now() + 15000;
  let tree;
  try {
    while (Date.now() < deadline) {
      ({ frameTree: tree } = await chrome.cdp.send('Page.getFrameTree', {}, sessionId));
      if (tree.childFrames?.some((child) => child.frame.url.includes('vault.sliccy.ai')))
        return null;
      const { targetInfos } = await chrome.cdp.send('Target.getTargets');
      const own = targetInfos.find(
        (info) => info.type === 'iframe' && info.url.includes('vault.sliccy.ai')
      );
      if (own) return own.targetId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
  throw new Error(`the vault frame never committed: ${JSON.stringify(tree)}`);
}

async function lateCheck(t) {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  const { targetId } = await chrome.cdp.send('Target.createTarget', {
    url: `http://ordinary.test:${port}/late`,
  });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const early = await page.evaluate(late, {
    port,
    targetId,
  });
  assert.equal(early.granted, true, JSON.stringify(early));
  assert.equal(
    early.frameAttached,
    true,
    `no frameAttached for the new iframe: ${JSON.stringify(early)}`
  );
  const frameTarget = await committed(targetId);
  const out = await page.evaluate((own) => window.lateRig(own), frameTarget);
  if (frameTarget) {
    assert.match(
      out.frameTarget,
      /^slicc: refused:/,
      `the vault frame's own target: ${JSON.stringify(out)}`
    );
  }
  for (const [name, answer] of Object.entries(out.after)) {
    assert.match(
      answer,
      /^slicc: refused:|not found|No frame for given id/i,
      `after the vault commit, ${name}: ${JSON.stringify(out)}`
    );
  }
  assert.equal(out.leaked, false, JSON.stringify(out));
}

test(
  'frame commits a protected URL after attach: reads refused, on the extension path',
  { timeout: 3 * 60 * 1000 },
  (t) => lateCheck(t)
);

async function editors({ port }) {
  const { guardProtected, FAILED, UNGUARDED } = await import(
    new URL('guard.js', location.href).href
  );
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const { guardOf } = await import(new URL('held.js', location.href).href);
  const metadata = [];
  window.guardFrameMetadata = metadata;
  const is = guardOf(self.origin);
  const kind = (value) =>
    typeof value !== 'string' || value === ''
      ? 'empty'
      : is.url(value)
        ? 'protected'
        : value.startsWith('about:')
          ? 'about'
          : /^https?:\/\//.test(value)
            ? 'http'
            : value === 'null'
              ? 'null'
              : 'opaque';
  const shape = (frame) => ({
    url: kind(frame?.url),
    origin: kind(frame?.securityOrigin),
    loader: frame?.loaderId !== undefined,
  });
  const treeSeen = (view, message) => {
    const tree = message.result?.frameTree;
    const children = [];
    const pending = [...(tree?.childFrames ?? [])];
    while (pending.length) {
      const child = pending.shift();
      children.push(shape(child.frame));
      pending.push(...(child.childFrames ?? []));
    }
    metadata.push({ view, root: tree?.frame ? shape(tree.frame) : null, children });
  };
  const queries = new Set();
  const raw = extensionConnection(globalThis.sliccExtension.cdp);
  const transport = {
    send(text) {
      const message = JSON.parse(text);
      if (message.method === 'Page.getFrameTree') queries.add(message.id);
      if (message.id >= 2 ** 30 && message.method === 'Target.detachFromTarget')
        metadata.push({ decision: 'cut' });
      raw.send(text);
    },
    close() {
      raw.close?.();
    },
  };
  raw.onmessage = (text) => {
    const message = JSON.parse(text);
    if (queries.delete(message.id)) treeSeen('guard', message);
    transport.onmessage?.(text);
  };
  raw.onclose = (event) => transport.onclose?.(event);
  const connection = guardProtected(transport, self.origin);
  const pending = new Map();
  const callerTrees = new Set();
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (callerTrees.delete(message.id)) treeSeen('caller', message);
    if (message.error?.message === FAILED || message.error?.message === UNGUARDED)
      metadata.push({ decision: 'uncertain' });
    else if (message.error?.message?.startsWith('slicc: refused:'))
      metadata.push({ decision: 'refused' });
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      if (method === 'Page.getFrameTree') callerTrees.add(id);
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
  const created = await send('Target.createTarget', {
    url: `http://ordinary.test:${port}/editors`,
  });
  const targetId = created.result?.targetId;
  const session = (await send('Target.attachToTarget', { targetId, flatten: true })).result
    ?.sessionId;
  await send('Page.enable', {}, session);
  const deadline = Date.now() + 10000;
  let children = [];
  let tree;
  while (Date.now() < deadline) {
    tree = (await send('Page.getFrameTree', {}, session)).result?.frameTree;
    children = (tree?.childFrames ?? []).map((child) => child.frame);
    if (children.length === 2 && children.every((child) => child.url)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (children.length !== 2) throw new Error('the editor frames never committed');
  const out = {};
  for (const [index, child] of children.entries()) {
    const world = await send(
      'Page.createIsolatedWorld',
      { frameId: child.id, worldName: 'utility' },
      session
    );
    const contextId = world.result?.executionContextId;
    const value = `FILLED-${index}`;
    const filled = await send(
      'Runtime.evaluate',
      {
        expression: `document.body.textContent = ${JSON.stringify(value)}; document.body.textContent`,
        contextId,
        returnByValue: true,
      },
      session
    );
    out[index === 0 ? 'blank' : 'srcdoc'] = {
      world: world.error?.message ?? 'world',
      value: filled.result?.result?.value ?? filled.error?.message,
    };
  }
  await send('Target.closeTarget', { targetId });
  return out;
}

async function editorsCheck(t) {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  try {
    const out = await page.evaluate(editors, {
      port,
    });
    assert.deepEqual(
      out,
      {
        blank: { world: 'world', value: 'FILLED-0' },
        srcdoc: { world: 'world', value: 'FILLED-1' },
      },
      'an editor in an about:blank and a srcdoc frame of an ordinary page gets a utility world and is filled'
    );
  } catch (error) {
    t.diagnostic(
      `guard-frame-metadata: ${JSON.stringify(await page.evaluate(() => window.guardFrameMetadata ?? []).catch(() => []))}`
    );
    throw error;
  }
}

test(
  'an ordinary page’s about:blank and srcdoc editors get a utility world and are filled, on the extension path',
  { timeout: 3 * 60 * 1000 },
  (t) => editorsCheck(t)
);

async function axTree({ port }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const connection = guardProtected(
    extensionConnection(globalThis.sliccExtension.cdp),
    self.origin
  );
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
  const created = await send('Target.createTarget', {
    url: `http://ordinary.test:${port}/linking`,
  });
  const targetId = created.result?.targetId;
  const session = (await send('Target.attachToTarget', { targetId, flatten: true })).result
    ?.sessionId;
  const deadline = Date.now() + 10000;
  let ax = {};
  while (Date.now() < deadline) {
    ax = await send('Accessibility.getFullAXTree', {}, session);
    if (JSON.stringify(ax.result ?? {}).includes('see http')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await send('Target.closeTarget', { targetId });
  return {
    ax: ax.error?.message ?? 'answered',
    text: JSON.stringify(ax.result ?? {}).includes('see http'),
    origin: JSON.stringify(ax.result ?? {}).includes('vault.sliccy.ai'),
    leaked: seen.some((text) => text.includes('AXMARK')),
  };
}

async function axCheck(t) {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  const out = await page.evaluate(axTree, {
    port,
  });
  assert.deepEqual(
    out,
    { ax: 'answered', text: true, origin: true, leaked: false },
    JSON.stringify(out)
  );
}

test(
  'an AX tree of an ordinary page keeps a vault link only as its origin, on the extension path',
  { timeout: 3 * 60 * 1000 },
  (t) => axCheck(t)
);
