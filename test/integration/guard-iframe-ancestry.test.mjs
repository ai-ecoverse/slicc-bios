import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const CROSS = 'https://cross.invalid/inner';
const SECRET = `${protectedOrigin}/vault/secret-frame`;
const NESTED = 'https://nested.invalid/inside-protected';
const REFUSED = /slicc: refused/;

const settle = async (rounds = 200) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};

const frameAt = (id, parentId, url) => ({
  id,
  ...(parentId ? { parentId } : {}),
  loaderId: `${id}-loader`,
  url,
  securityOrigin: URL.canParse(url) && url.startsWith('http') ? new URL(url).origin : '://',
});

function listing(raw, infos) {
  const send = raw.send.bind(raw);
  raw.send = (text) => {
    const message = JSON.parse(text);
    if (message.method !== 'Target.getTargets') return send(text);
    queueMicrotask(() =>
      raw.onmessage(
        JSON.stringify({ id: message.id, result: { targetInfos: infos().map((i) => i.info) } })
      )
    );
  };
  return raw;
}

function setup(t) {
  const p = protocol(t, (raw, own) =>
    guardProtected(
      listing(raw, () => [...p.targets.values()]),
      own
    )
  );
  return p;
}

async function placedPage(t, id = 'root', url) {
  const p = setup(t);
  const root = p.target(id, 'page', {
    ...plainFrame(id),
    ...(url ? { url, securityOrigin: new URL(url).origin } : {}),
    loaderId: `${id}-loader`,
  });
  const session = await p.attach(id);
  return { p, root, session };
}

function frame(p, id, url, parentId, reported = parentId) {
  return p.target(id, 'iframe', frameAt(id, parentId, url), reported);
}

async function attachUnder(p, id, owner) {
  const sessionId = `client-${id}`;
  p.sessions.set(sessionId, id);
  p.emit({
    method: 'Target.attachedToTarget',
    sessionId: owner,
    params: { sessionId, targetInfo: p.targets.get(id).info, waitingForDebugger: true },
  });
  await settle();
  return sessionId;
}

const shown = (p, sessionId) =>
  p.delivered.some(
    (message) =>
      message.method === 'Target.attachedToTarget' && message.params?.sessionId === sessionId
  );
const detachedTo = (p, sessionId) =>
  p.delivered.some(
    (message) =>
      message.method === 'Target.detachedFromTarget' && message.params?.sessionId === sessionId
  );
const cutInChrome = (p, sessionId) =>
  p.sent.some(
    (message) =>
      message.method === 'Target.detachFromTarget' && message.params?.sessionId === sessionId
  );
const leaks = (p, ...values) =>
  values.filter((value) => JSON.stringify(p.delivered).includes(value));
const listed = async (p, id) =>
  (await p.send('Target.getTargets', {})).result.targetInfos.some((info) => info.targetId === id);
const evaluate = (p, sessionId) =>
  p.send('Runtime.evaluate', { expression: 'window.parent.postMessage("x", "*")' }, sessionId);

async function unreachable(p, id) {
  assert.equal(await listed(p, id), false, `${id} is not listed`);
  assert.match(
    (await p.send('Target.getTargetInfo', { targetId: id })).error?.message ?? '',
    REFUSED,
    `getTargetInfo of ${id} is refused`
  );
  const attached = await p.send('Target.attachToTarget', { targetId: id, flatten: true });
  assert.match(attached.error?.message ?? '', REFUSED, `attaching ${id} is refused`);
}

test('an ordinary iframe nested inside a protected iframe is cut, unlisted, undiscovered and unattachable', async (t) => {
  const { p, session } = await placedPage(t);
  frame(p, 'secret', SECRET, 'root');
  frame(p, 'nested', NESTED, 'secret');
  const child = await attachUnder(p, 'nested', session);
  assert.ok(!shown(p, child), 'the nested iframe is never shown');
  assert.ok(cutInChrome(p, child), 'the nested iframe is detached');
  await unreachable(p, 'nested');
  frame(p, 'cross', CROSS, 'root');
  for (const id of ['nested', 'cross'])
    p.emit({ method: 'Target.targetCreated', params: { targetInfo: p.targets.get(id).info } });
  await settle();
  const created = p.delivered
    .filter((message) => message.method === 'Target.targetCreated')
    .map((message) => message.params.targetInfo.targetId);
  assert.deepEqual(created, ['cross'], 'only the ordinary iframe is discovered');
  assert.deepEqual(leaks(p, SECRET, NESTED), []);
});

test("an srcdoc iframe whose TargetInfo has no parentId and whose frame tree names seven's page is unlisted and unattachable", async (t) => {
  const p = setup(t);
  p.target('seven', 'page', {
    ...plainFrame('seven'),
    url: `${protectedOrigin}/os/`,
    securityOrigin: protectedOrigin,
  });
  frame(p, 'sprinkle', 'about:srcdoc', 'seven', null);
  frame(p, 'framed', 'about:srcdoc', 'seven', null).info.parentFrameId = 'seven';
  await unreachable(p, 'sprinkle');
  await unreachable(p, 'framed');
  assert.ok(
    !p.clients().some((message) => message.method === 'Runtime.evaluate'),
    'no command reaches the sprinkle frame'
  );
});

test('an ordinary iframe with no parentId is admitted once its frame ancestry is recorded from its ordinary page', async (t) => {
  const { p, session } = await placedPage(t);
  frame(p, 'cross', CROSS, 'root', null);
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'cross', parentFrameId: 'root' },
  });
  await settle();
  const attached = await p.send('Target.attachToTarget', { targetId: 'cross', flatten: true });
  assert.equal(attached.error, undefined);
  assert.equal((await evaluate(p, attached.result.sessionId)).error, undefined);
});

test('an iframe with no parent from any source is unlisted and unattachable', async (t) => {
  const { p } = await placedPage(t);
  frame(p, 'orphan', CROSS, null, null);
  await unreachable(p, 'orphan');
});

test("an iframe attached from the browser session is cut when its owning page's session is cut", async (t) => {
  const { p, root, session } = await placedPage(t);
  frame(p, 'cross', CROSS, 'root');
  const attached = await p.send('Target.attachToTarget', { targetId: 'cross', flatten: true });
  const child = attached.result.sessionId;
  assert.equal((await evaluate(p, child)).error, undefined);
  root.info.url = SECRET;
  root.tree.frame = { ...root.tree.frame, url: SECRET, securityOrigin: protectedOrigin };
  p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: root.info } });
  await settle();
  assert.ok(detachedTo(p, session), 'the page session is cut');
  assert.ok(detachedTo(p, child), 'the separately attached iframe session is cut too');
  assert.match((await evaluate(p, child)).error?.message ?? '', REFUSED);
});

test('an iframe attached from the browser session refuses commands once its owning page turns protected, with no event about it', async (t) => {
  const { p, root } = await placedPage(t);
  frame(p, 'cross', CROSS, 'root');
  const attached = await p.send('Target.attachToTarget', { targetId: 'cross', flatten: true });
  const child = attached.result.sessionId;
  assert.equal((await evaluate(p, child)).error, undefined);
  root.info.url = SECRET;
  assert.match((await evaluate(p, child)).error?.message ?? '', REFUSED);
  assert.ok(cutInChrome(p, child), 'the iframe session is cut');
});

test('an iframe refuses commands, postMessage to its parent included, once its owning page is held', async (t) => {
  const { p } = await placedPage(t, 'owner');
  frame(p, 'held-cross', CROSS, 'owner');
  const attached = await p.send('Target.attachToTarget', { targetId: 'held-cross', flatten: true });
  const child = attached.result.sessionId;
  assert.equal((await evaluate(p, child)).error, undefined);
  hold('owner');
  const before = p.sent.length;
  assert.match((await evaluate(p, child)).error?.message ?? '', REFUSED);
  assert.ok(
    !p
      .clients(before)
      .some((message) => message.method === 'Runtime.evaluate' && message.sessionId === child),
    'the evaluate never reaches Chrome'
  );
});

test('an iframe whose reported parent disagrees with the session it attached under is never shown', async (t) => {
  const { p, session } = await placedPage(t);
  p.target('other', 'page');
  frame(p, 'cross', CROSS, 'root', 'other');
  const child = await attachUnder(p, 'cross', session);
  assert.ok(!shown(p, child), 'the iframe is never shown');
  assert.ok(cutInChrome(p, child));
});

test('an iframe of a held sign-in page with no parentId is cut and never shown', async (t) => {
  const { p, session } = await placedPage(t, 'signin');
  hold('signin');
  frame(p, 'idp-frame', CROSS, 'signin', null);
  const child = await attachUnder(p, 'idp-frame', session);
  assert.ok(!shown(p, child));
  assert.ok(cutInChrome(p, child));
  assert.deepEqual(leaks(p, CROSS), []);
});

test('an iframe that finishes placement under a page session the guard already cut is cut', async (t) => {
  const { p, root, session } = await placedPage(t);
  frame(p, 'cross', CROSS, 'root');
  root.info.url = SECRET;
  root.tree.frame = { ...root.tree.frame, url: SECRET, securityOrigin: protectedOrigin };
  p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: root.info } });
  await settle();
  assert.ok(detachedTo(p, session));
  const child = await attachUnder(p, 'cross', session);
  assert.ok(!shown(p, child));
  assert.ok(cutInChrome(p, child));
});

test('a shown iframe is cut with the page session it attached under', async (t) => {
  const { p, root, session } = await placedPage(t);
  frame(p, 'cross', CROSS, 'root');
  const child = await attachUnder(p, 'cross', session);
  assert.ok(shown(p, child));
  root.info.url = SECRET;
  root.tree.frame = { ...root.tree.frame, url: SECRET, securityOrigin: protectedOrigin };
  p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: root.info } });
  await settle();
  assert.ok(detachedTo(p, child));
  assert.match((await evaluate(p, child)).error?.message ?? '', REFUSED);
});

test('an ordinary iframe whose parent frame is a same-process subframe is admitted through the recorded frame chain', async (t) => {
  const { p, session } = await placedPage(t);
  frame(p, 'cross', CROSS, 'sub', null);
  for (const [frameId, parentFrameId] of [
    ['sub', 'root'],
    ['cross', 'sub'],
  ])
    p.emit({
      sessionId: session,
      method: 'Page.frameAttached',
      params: { frameId, parentFrameId },
    });
  await settle();
  const attached = await p.send('Target.attachToTarget', { targetId: 'cross', flatten: true });
  assert.equal(attached.error, undefined);
});

test('a target hint about a shown iframe re-judges it, and one under a protected frame quarantines it', async (t) => {
  const { p, root, session } = await placedPage(t);
  frame(p, 'cross', CROSS, 'root');
  const child = await attachUnder(p, 'cross', session);
  assert.ok(shown(p, child));
  p.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { targetId: 'cross', url: CROSS } },
  });
  p.target('ghost', 'page');
  p.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { targetId: 'ghost', url: CROSS } },
  });
  await settle();
  assert.equal((await evaluate(p, child)).error, undefined);
  frame(p, 'inner', CROSS, 'cross');
  const nested = await attachUnder(p, 'inner', child);
  assert.ok(shown(p, nested));
  root.info.url = SECRET;
  p.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: p.targets.get('inner').info },
  });
  await settle();
  assert.match((await evaluate(p, nested)).error?.message ?? '', REFUSED);
});

test('an iframe under a protected frame in the recorded chain is refused', async (t) => {
  const { p, session } = await placedPage(t);
  frame(p, 'cross', CROSS, 'secret-sub', null);
  p.emit({
    sessionId: session,
    method: 'Page.frameNavigated',
    params: {
      frame: {
        id: 'secret-sub',
        parentId: 'root',
        loaderId: 'l',
        url: SECRET,
        securityOrigin: protectedOrigin,
      },
    },
  });
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'cross', parentFrameId: 'secret-sub' },
  });
  await settle();
  await unreachable(p, 'cross');
});

test('an iframe session refuses commands once Chrome has detached the session it attached under', async (t) => {
  const { p, session } = await placedPage(t);
  frame(p, 'cross', CROSS, 'root');
  const child = await attachUnder(p, 'cross', session);
  assert.ok(shown(p, child));
  p.emit({ method: 'Target.detachedFromTarget', params: { sessionId: session } });
  await settle();
  assert.match((await evaluate(p, child)).error?.message ?? '', REFUSED);
});

test("an ordinary iframe whose parent frame is a page's root frame under another id is admitted through that page", async (t) => {
  const p = setup(t);
  p.target('host', 'page', { ...plainFrame('host-root'), loaderId: 'host-loader' });
  await p.attach('host');
  frame(p, 'kid', CROSS, 'host-root', null).info.parentFrameId = 'host-root';
  const attached = await p.send('Target.attachToTarget', { targetId: 'kid', flatten: true });
  assert.equal(attached.error, undefined);
});

for (const shape of ['parentId', 'recorded parent frame'])
  test(`an iframe named by a browser-level request is refused once its owner turns protected without an event (${shape})`, async (t) => {
    const p = setup(t);
    const byFrame = shape !== 'parentId';
    const owner = p.target('stale-owner', 'page', {
      ...plainFrame(byFrame ? 'stale-owner-root' : 'stale-owner'),
      loaderId: 'stale-loader',
    });
    await p.attach('stale-owner');
    const child = frame(p, 'stale-frame', CROSS, null, byFrame ? null : 'stale-owner');
    if (byFrame) child.info.parentFrameId = 'stale-owner-root';
    assert.equal(
      (await p.send('Target.getTargetInfo', { targetId: 'stale-frame' })).error,
      undefined
    );
    owner.info.url = `${protectedOrigin}/os/`;
    assert.match(
      (await p.send('Target.getTargetInfo', { targetId: 'stale-frame' })).error?.message ?? '',
      REFUSED
    );
    const attached = await p.send('Target.attachToTarget', {
      targetId: 'stale-frame',
      flatten: true,
    });
    assert.match(attached.error?.message ?? '', REFUSED);
  });

test('a new iframe attachment under an owner that turned protected without an event reaches the client as nothing', async (t) => {
  const { p, root, session } = await placedPage(t, 'quiet-owner');
  frame(p, 'quiet-frame', CROSS, 'quiet-owner');
  root.info.url = `${protectedOrigin}/os/`;
  const before = p.delivered.length;
  const child = await attachUnder(p, 'quiet-frame', session);
  assert.ok(!shown(p, child), 'the iframe attachment is never published');
  assert.ok(cutInChrome(p, child), 'the iframe is detached');
  assert.deepEqual(
    p.delivered
      .slice(before)
      .filter(
        (message) =>
          JSON.stringify(message).includes(child) || JSON.stringify(message).includes(CROSS)
      ),
    [],
    'nothing about the iframe reaches the client'
  );
});

test('an iframe two levels below an owner that turns protected without an event refuses commands', async (t) => {
  const { p, root } = await placedPage(t, 'deep-owner');
  frame(p, 'deep-mid', CROSS, 'deep-owner');
  frame(p, 'deep-kid', NESTED, 'deep-mid');
  const attached = await p.send('Target.attachToTarget', { targetId: 'deep-kid', flatten: true });
  const child = attached.result.sessionId;
  assert.equal((await evaluate(p, child)).error, undefined);
  root.info.url = `${protectedOrigin}/os/`;
  assert.match((await evaluate(p, child)).error?.message ?? '', REFUSED);
  assert.match(
    (await p.send('Target.getTargetInfo', { targetId: 'deep-kid' })).error?.message ?? '',
    REFUSED
  );
});

test('an iframe whose middle ancestor turns held without an event refuses commands', async (t) => {
  const { p } = await placedPage(t, 'held-top');
  frame(p, 'held-mid', CROSS, 'held-top');
  frame(p, 'held-low', NESTED, 'held-mid');
  const attached = await p.send('Target.attachToTarget', { targetId: 'held-low', flatten: true });
  const child = attached.result.sessionId;
  assert.equal((await evaluate(p, child)).error, undefined);
  hold('held-mid');
  assert.match((await evaluate(p, child)).error?.message ?? '', REFUSED);
});
