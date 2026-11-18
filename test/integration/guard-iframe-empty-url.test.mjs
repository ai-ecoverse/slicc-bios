import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

const MID = 'https://cross.test/oopif-mid';
const SEVEN = `${protectedOrigin}/controller/oopif-mid`;
const route = { kind: 'link' };

const settle = async (rounds = 60) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};

const frameAt = (id, parentId, url) => ({
  id,
  parentId,
  loaderId: `${id}-loader`,
  url,
  securityOrigin: URL.canParse(url) ? new URL(url).origin : '://',
});

function listing(raw, guard, infos) {
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
  return guard(raw);
}

async function nest(
  t,
  { tree = MID, own = MID, before, reported = 'top', extra = {}, twice } = {}
) {
  const p = protocol(t, (raw, owner) =>
    listing(
      raw,
      (wired) => guardProtected(wired, owner, new Map(), route),
      () => [...p.targets.values()]
    )
  );
  const top = p.target('top', 'page', { ...plainFrame('top'), loaderId: 'top-loader' });
  const session = await p.attach('top');
  assert.equal(await enable(p, session), undefined);
  await before?.(p);
  const mid = p.target('mid', 'iframe', frameAt('mid', 'top', own), reported);
  Object.assign(mid.info, { url: '' }, extra);
  if (tree !== null) top.tree.childFrames = [{ frame: frameAt('mid', 'top', tree) }];
  if (twice) top.tree.childFrames.push({ frame: frameAt('mid', 'top', twice) });
  const child = 'client-mid';
  p.sessions.set(child, 'mid');
  p.emit({
    method: 'Target.attachedToTarget',
    sessionId: session,
    params: { sessionId: child, targetInfo: { ...mid.info }, waitingForDebugger: false },
  });
  await settle();
  return { p, top, mid, session, child };
}

const heard = (p, requestId) =>
  p.delivered.some(
    (message) =>
      message.method === 'Network.requestWillBeSent' && message.params?.requestId === requestId
  );

async function request(p, session, requestId) {
  p.emit({
    sessionId: session,
    method: 'Network.requestWillBeSent',
    params: { requestId, loaderId: 'top-loader', request: { url: MID, method: 'GET' } },
  });
  await settle();
  return heard(p, requestId);
}

async function enable(p, session) {
  return (await p.send('Runtime.enable', {}, session)).error?.message;
}

async function claimed(p, id, frame) {
  p.target(id, 'page', frame);
  const session = await p.attach(id);
  await p.send('Page.getFrameTree', {}, session);
  assert.equal(await enable(p, session), undefined);
  await settle();
}

test('over link, an ordinary OOPIF attached with an empty URL is proven from a fresh read of the parent frame tree', async (t) => {
  const { p, session } = await nest(t);
  assert.equal(await enable(p, session), undefined);
});

test('over link, an OOPIF attached with an empty URL that the parent tree places on seven stays refused', async (t) => {
  const { p, session } = await nest(t, { tree: SEVEN, own: SEVEN });
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an OOPIF attached with an empty URL that the parent tree does not hold stays refused', async (t) => {
  const { p, session } = await nest(t, { tree: null });
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an OOPIF attached with an empty URL that the parent tree holds unparseable stays refused', async (t) => {
  const { p, session } = await nest(t, { tree: 'not a url', own: 'not a url' });
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, a stale ordinary parent tree does not prove an OOPIF whose own tree is on seven', async (t) => {
  const { p, session } = await nest(t, { own: SEVEN });
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, a stale ordinary parent tree does not prove an OOPIF whose target info arrives on seven', async (t) => {
  const { p, mid, session } = await nest(t, { own: SEVEN });
  mid.info.url = SEVEN;
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an OOPIF proven from the parent tree that then reports seven locks its top again', async (t) => {
  const { p, mid, session } = await nest(t);
  assert.equal(await enable(p, session), undefined);
  assert.ok(await request(p, session, 'before'));
  mid.info.url = SEVEN;
  mid.tree.frame = frameAt('mid', 'top', SEVEN);
  p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...mid.info } } });
  await settle();
  assert.equal(await request(p, session, 'after'), false);
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an OOPIF proven from the parent tree that then navigates is judged again', async (t) => {
  const { p, mid, session, child } = await nest(t);
  assert.equal(await enable(p, session), undefined);
  assert.ok(await request(p, session, 'before'));
  mid.tree.frame = frameAt('mid', 'top', 'not a url');
  p.emit({ sessionId: child, method: 'Page.frameNavigated', params: { frame: mid.tree.frame } });
  await settle();
  assert.equal(await request(p, session, 'after'), false);
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF whose frame id is the root of another target stays refused', async (t) => {
  const { p, session } = await nest(t, {
    before: (p) => claimed(p, 'twin', { ...plainFrame('mid'), loaderId: 'twin-loader' }),
  });
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF reported under another page than the one it attached on stays refused there', async (t) => {
  const { p } = await nest(t, {
    reported: 'other',
    before: (p) => claimed(p, 'other', { ...plainFrame('other'), loaderId: 'other-loader' }),
  });
  assert.equal(await enable(p, 'client-other'), PROTECTED);
});

test('over link, an empty OOPIF whose attach names a parent frame of another page stays refused', async (t) => {
  const { p, session } = await nest(t, {
    extra: { parentFrameId: 'other' },
    before: (p) => claimed(p, 'other', { ...plainFrame('other'), loaderId: 'other-loader' }),
  });
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF that the parent tree holds at an inheriting URL stays refused', async (t) => {
  const { p, session } = await nest(t, { tree: 'about:blank', own: 'about:blank' });
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF that the parent tree lists twice stays refused', async (t) => {
  const { p, session } = await nest(t, { twice: 'https://cross.test/twin' });
  assert.equal(await enable(p, session), PROTECTED);
});
