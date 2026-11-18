import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

const MID = 'https://cross.test/oopif-mid';
const SEVEN = `${protectedOrigin}/controller/oopif-mid`;
const route = { kind: 'link' };
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function browserAttach(p, id, sessionId, info, under) {
  p.sessions.set(sessionId, id);
  p.emit({
    method: 'Target.attachedToTarget',
    ...(under ? { sessionId: under } : {}),
    params: { sessionId, targetInfo: { ...info }, waitingForDebugger: false },
  });
}

async function enable(p, session) {
  return (await p.send('Runtime.enable', {}, session)).error?.message;
}

const attachedOf = (p, sessionId) =>
  p.delivered.some(
    (message) =>
      message.method === 'Target.attachedToTarget' && message.params?.sessionId === sessionId
  );

const detachedOf = (p, sessionId) =>
  p.delivered.some(
    (message) =>
      message.method === 'Target.detachedFromTarget' && message.params?.sessionId === sessionId
  );

async function claimed(p, id) {
  p.target(id, 'page', { ...plainFrame(id), loaderId: `${id}-loader` });
  browserAttach(p, id, `auto-${id}`, p.targets.get(id).info);
  await settle();
}

function routed(t, kind) {
  const p = protocol(t, (raw, owner) =>
    listing(
      raw,
      (wired) => guardProtected(wired, owner, new Map(), kind),
      () => [...p.targets.values()]
    )
  );
  return p;
}

const midReads = (p, since) =>
  p.sent
    .slice(since)
    .filter(
      (message) =>
        message.id >= 2 ** 30 &&
        message.method === 'Target.getTargetInfo' &&
        message.params?.targetId === 'mid'
    ).length;

async function clientNest(t, kind, { arrives, tree = MID } = {}) {
  const p = routed(t, kind);
  const top = p.target('top', 'page', { ...plainFrame('top'), loaderId: 'top-loader' });
  const session = await p.attach('top');
  assert.equal(await enable(p, session), undefined);
  const mid = p.target('mid', 'iframe', frameAt('mid', 'top', MID), 'top');
  mid.info.url = '';
  if (tree) top.tree.childFrames = [{ frame: frameAt('mid', 'top', tree) }];
  p.sessions.set('client-mid', 'mid');
  p.emit({
    method: 'Target.attachedToTarget',
    sessionId: session,
    params: { sessionId: 'client-mid', targetInfo: { ...mid.info }, waitingForDebugger: false },
  });
  if (arrives !== undefined) {
    await later(arrives);
    mid.info.url = MID;
  }
  return { p, session, mid };
}

const shownWith = (p, sessionId) =>
  p.delivered.find(
    (message) =>
      message.method === 'Target.attachedToTarget' && message.params?.sessionId === sessionId
  )?.params.targetInfo.url;

async function linkNest(
  t,
  {
    tree = MID,
    own = MID,
    topUrl,
    topSession = true,
    twice,
    reported = 'top',
    extra = {},
    before,
    during,
    leaf,
    named,
    under,
    client = true,
  } = {}
) {
  const p = routed(t, route);
  const topFrame = { ...plainFrame('top'), loaderId: 'top-loader' };
  if (topUrl !== undefined) Object.assign(topFrame, { url: topUrl, securityOrigin: '://' });
  const top = p.target('top', 'page', topFrame);
  if (topSession) browserAttach(p, 'top', 'auto-top', top.info);
  await settle();
  await before?.(p);
  const mid = p.target('mid', 'iframe', frameAt('mid', 'top', own), reported);
  Object.assign(mid.info, { url: '' }, extra);
  if (tree !== null) top.tree.childFrames = [{ frame: frameAt('mid', 'top', tree) }];
  if (twice) top.tree.childFrames.push({ frame: frameAt('mid', 'top', twice) });
  if (leaf) mid.tree.childFrames = [{ frame: frameAt('leaf', 'mid', leaf) }];
  if (during) await during(p, top, mid);
  browserAttach(p, 'mid', 'auto-mid', mid.info, under);
  if (named) mid.info.url = named;
  await settle();
  if (leaf) {
    const node = p.target('leaf', 'iframe', frameAt('leaf', 'mid', leaf), 'mid');
    node.info.url = '';
    p.sessions.set('auto-leaf', 'leaf');
    p.emit({
      method: 'Target.attachedToTarget',
      sessionId: 'auto-mid',
      params: { sessionId: 'auto-leaf', targetInfo: { ...node.info }, waitingForDebugger: false },
    });
    await settle();
  }
  const session = client ? await p.attach('top') : undefined;
  await settle();
  return { p, top, mid, session };
}

test('over link, an ordinary OOPIF attached empty with no page parent session is proven from a fresh read of its owner tree', async (t) => {
  const { p, session } = await linkNest(t);
  assert.ok(attachedOf(p, 'auto-mid'));
  assert.equal(await enable(p, session), undefined);
  assert.equal(await enable(p, 'auto-mid'), undefined);
});

test('over link, an empty OOPIF without an owner session whose target info then names its URL is admitted from the target info', async (t) => {
  const { p } = await linkNest(t, { topSession: false, client: false, tree: null, named: MID });
  assert.ok(attachedOf(p, 'auto-mid'));
  assert.equal(await enable(p, 'auto-mid'), undefined);
});

test('over link, an empty grandchild under an estimated OOPIF is admitted only by its own fresh read of the OOPIF tree', async (t) => {
  const { p, session } = await linkNest(t, { leaf: 'https://leaf.test/oopif-leaf' });
  assert.ok(attachedOf(p, 'auto-leaf'));
  assert.equal(await enable(p, 'auto-leaf'), undefined);
  assert.equal(await enable(p, 'auto-mid'), undefined);
  assert.equal(await enable(p, session), undefined);
});

test('over link, a grandchild that the estimated OOPIF tree places on seven stays refused, and so does its top', async (t) => {
  const { p, session } = await linkNest(t, { leaf: SEVEN });
  assert.equal(attachedOf(p, 'auto-leaf'), false);
  assert.equal(await enable(p, 'auto-leaf'), PROTECTED);
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF with no page parent session that its owner tree places on seven stays refused', async (t) => {
  const { p } = await linkNest(t, { tree: SEVEN, client: false });
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, 'auto-mid'), PROTECTED);
  assert.ok((await p.send('Target.attachToTarget', { targetId: 'top', flatten: true })).error);
});

for (const [name, options] of [
  ['does not list', { tree: null }],
  ['holds unparseable', { tree: 'not a url' }],
  ['holds at an inheriting URL', { tree: 'about:blank' }],
  ['holds at a URL with user info', { tree: 'https://user:secret@cross.test/oopif-mid' }],
  ['holds at a blob URL', { tree: 'blob:https://cross.test/0' }],
  ['lists twice', { twice: 'https://cross.test/twin' }],
  ['names ordinary while the OOPIF own tree is on seven', { own: SEVEN }],
]) {
  test(`over link, an empty OOPIF with no page parent session that its owner tree ${name} stays refused`, async (t) => {
    const { p } = await linkNest(t, { ...options, client: false });
    assert.equal(attachedOf(p, 'auto-mid'), false);
    assert.equal(await enable(p, 'auto-mid'), PROTECTED);
  });
}

test('over link, an empty OOPIF with no page parent session whose frame id is the root of another target stays refused', async (t) => {
  const { p, session } = await linkNest(t, {
    before: async (p) => {
      p.target('twin', 'page', { ...plainFrame('mid'), loaderId: 'twin-loader' });
      browserAttach(p, 'twin', 'auto-twin', p.targets.get('twin').info);
      await settle();
    },
  });
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF with no page parent session reported under a page whose tree does not hold it stays refused', async (t) => {
  const { p } = await linkNest(t, { reported: 'other', before: (p) => claimed(p, 'other') });
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, 'auto-other'), PROTECTED);
});

test('over link, an empty OOPIF with no page parent session and two candidate owners stays refused', async (t) => {
  const { p, session } = await linkNest(t, {
    extra: { parentFrameId: 'other' },
    before: (p) => claimed(p, 'other'),
  });
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF whose owner is a protected page stays refused', async (t) => {
  const { p } = await linkNest(t, { topUrl: SEVEN, client: false });
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, 'auto-mid'), PROTECTED);
});

test('over link, an empty OOPIF whose owner session is still held stays refused', async (t) => {
  const { p } = await linkNest(t, {
    client: false,
    topSession: false,
    before: (p) => {
      const top = p.targets.get('top');
      top.info.url = '';
      browserAttach(p, 'top', 'auto-top', top.info);
      return settle();
    },
  });
  assert.equal(attachedOf(p, 'auto-top'), false);
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, 'auto-mid'), PROTECTED);
});

test('over link, a command on an empty OOPIF whose owner never has a live session is refused within the hold bound', async (t) => {
  const { p } = await linkNest(t, { topSession: false, client: false });
  const started = Date.now();
  const answer = await p.send('Runtime.evaluate', { expression: '1' }, 'auto-mid');
  assert.equal(answer.error?.message, PROTECTED);
  assert.ok(Date.now() - started < 2000);
  assert.equal(attachedOf(p, 'auto-mid'), false);
});

test('over link, a command on an empty OOPIF whose owner tree read never answers is refused within the hold bound', async (t) => {
  const { p } = await linkNest(t, {
    client: false,
    during: (p) =>
      p.hold(
        (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'auto-top'
      ),
  });
  const started = Date.now();
  const answer = await p.send('Runtime.evaluate', { expression: '1' }, 'auto-mid');
  assert.equal(answer.error?.message, PROTECTED);
  assert.ok(Date.now() - started < 2000);
  assert.ok(p.held.length > 0);
  assert.equal(attachedOf(p, 'auto-mid'), false);
});

test('over link, a target info change of the OOPIF while its owner tree is read voids the estimate until a fresh read', async (t) => {
  let held;
  const { p, session } = await linkNest(t, {
    during: (p, top, mid) => {
      p.hold((message) => {
        if (held || message.method !== 'Page.getFrameTree' || message.sessionId !== 'auto-top')
          return false;
        held = message;
        return true;
      });
      queueMicrotask(async () => {
        for (let i = 0; !held && i < 200; i += 1) await flush();
        if (!held) return;
        p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...mid.info } } });
        await flush();
        p.release(held);
      });
    },
  });
  assert.ok(held);
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, session), undefined);
});

test('over link, a second attach of the OOPIF under another page while its owner tree is read voids the estimate', async (t) => {
  let held;
  const { p, session } = await linkNest(t, {
    before: (p) => claimed(p, 'other'),
    during: (p, top, mid) => {
      p.hold((message) => {
        if (held || message.method !== 'Page.getFrameTree' || message.sessionId !== 'auto-top')
          return false;
        held = message;
        return true;
      });
      queueMicrotask(async () => {
        for (let i = 0; !held && i < 200; i += 1) await flush();
        if (!held) return;
        p.sessions.set('other-mid', 'mid');
        p.emit({
          method: 'Target.attachedToTarget',
          sessionId: 'auto-other',
          params: {
            sessionId: 'other-mid',
            targetInfo: { ...mid.info },
            waitingForDebugger: false,
          },
        });
        await flush();
        p.release(held);
      });
    },
  });
  assert.ok(held);
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an OOPIF estimated from its owner tree that then reports seven is cut and locks its top again', async (t) => {
  const { p, mid, session } = await linkNest(t);
  assert.equal(await enable(p, session), undefined);
  mid.info.url = SEVEN;
  mid.tree.frame = frameAt('mid', 'top', SEVEN);
  p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...mid.info } } });
  await settle();
  assert.ok(detachedOf(p, 'auto-mid'));
  assert.equal(await enable(p, session), PROTECTED);
  assert.equal(await enable(p, 'auto-mid'), PROTECTED);
});

test('over link, an OOPIF estimated from its owner tree that then navigates to seven is cut before the next read', async (t) => {
  const { p, mid, session } = await linkNest(t);
  assert.equal(await enable(p, 'auto-mid'), undefined);
  mid.tree.frame = frameAt('mid', 'top', SEVEN);
  p.emit({
    sessionId: 'auto-mid',
    method: 'Page.frameNavigated',
    params: { frame: mid.tree.frame },
  });
  await settle();
  assert.ok(detachedOf(p, 'auto-mid'));
  const answer = await p.send('Runtime.evaluate', { expression: 'location.href' }, 'auto-mid');
  assert.equal(answer.result, undefined);
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF attached under a session the guard cannot map stays refused although its owner tree lists it', async (t) => {
  const { p, session } = await linkNest(t, { under: 'unmapped' });
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, 'auto-mid'), PROTECTED);
  assert.equal(await enable(p, session), PROTECTED);
});

test('over link, an empty OOPIF attached under a session on another target stays refused although the owner tree lists it', async (t) => {
  const { p, session } = await linkNest(t, {
    before: (p) => claimed(p, 'other'),
    under: 'auto-other',
  });
  assert.equal(attachedOf(p, 'auto-mid'), false);
  assert.equal(await enable(p, session), PROTECTED);
});

for (const [kind, tree] of [
  ['devtools', MID],
  ['devtools', null],
  ['extension', MID],
  ['link', null],
]) {
  const listed = tree ? 'its top tree lists' : 'its top tree does not list';
  test(`over ${kind}, an empty iframe under the client top session that ${listed}, whose URL arrives at 300 ms, is shown with the URL and leaves no proof pending`, async (t) => {
    const { p, session, mid } = await clientNest(t, { kind }, { arrives: 300, tree });
    await later(300);
    await settle();
    assert.equal(shownWith(p, 'client-mid'), MID);
    assert.equal(await enable(p, 'client-mid'), undefined);
    p.emit({
      sessionId: 'guard-mid',
      method: 'Page.frameNavigated',
      params: { frame: mid.tree.frame },
    });
    await settle();
    assert.equal(await enable(p, session), undefined);
    const since = p.sent.length;
    assert.equal(await enable(p, session), undefined);
    assert.equal(midReads(p, since), 0);
  });
}

test('over devtools, an empty iframe under the client top session whose URL never arrives is cut after the 10 s wait as before', async (t) => {
  const { p } = await clientNest(t, { kind: 'devtools' });
  await later(2000);
  await settle();
  assert.equal(shownWith(p, 'client-mid'), undefined);
  assert.equal(
    p.sent.some(
      (message) =>
        message.method === 'Target.detachFromTarget' && message.params?.sessionId === 'client-mid'
    ),
    false
  );
  await later(9500);
  await settle();
  assert.equal(shownWith(p, 'client-mid'), undefined);
  assert.ok(
    p.sent.some(
      (message) =>
        message.method === 'Target.detachFromTarget' && message.params?.sessionId === 'client-mid'
    )
  );
  assert.equal(await enable(p, 'client-mid'), PROTECTED);
});
