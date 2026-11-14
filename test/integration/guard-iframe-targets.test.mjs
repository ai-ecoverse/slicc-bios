import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const CROSS = 'https://cross.invalid/inner';
const SECRET = `${protectedOrigin}/vault/secret-frame`;
const PUPPETEER_BROWSER = [{ type: 'page', exclude: true }, {}];

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};

function frameAt(id, parentId, url) {
  return { id, parentId, loaderId: `${id}-loader`, url, securityOrigin: new URL(url).origin };
}

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

async function placedPage(t, id = 'root', extra) {
  const p = protocol(t, (raw, own) =>
    listing(
      raw,
      (wired) => guardProtected(wired, own),
      () => [...p.targets.values()]
    )
  );
  const root = p.target(id, 'page', { ...plainFrame(id), loaderId: `${id}-loader` });
  extra?.(p);
  const session = await p.attach(id);
  return { p, root, session };
}

function frame(p, id, url, parentId, owner, reported = parentId) {
  const target = p.target(id, 'iframe', frameAt(id, parentId, url), reported);
  return { target, attach: () => attachFrame(p, id, owner) };
}

async function attachFrame(p, id, owner, waitingForDebugger = true) {
  const sessionId = `client-${id}`;
  p.sessions.set(sessionId, id);
  p.emit({
    method: 'Target.attachedToTarget',
    sessionId: owner,
    params: { sessionId, targetInfo: p.targets.get(id).info, waitingForDebugger },
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
const resumed = (p, sessionId) =>
  p.sent.some(
    (message) =>
      message.method === 'Runtime.runIfWaitingForDebugger' && message.sessionId === sessionId
  );
const leaks = (p, ...values) =>
  values.filter((value) => JSON.stringify(p.delivered).includes(value));
const forwarded = (p, sessionId) =>
  p
    .clients()
    .filter(
      (message) => message.method === 'Target.setAutoAttach' && message.sessionId === sessionId
    )
    .at(-1)?.params?.filter;

test("a stock client's catch-all auto-attach reaches Chrome as tabs on the browser session and pages plus iframes below it", async (t) => {
  const { p, session } = await placedPage(t);
  const ask = (filter, sessionId) =>
    p.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter },
      sessionId
    );
  assert.equal((await ask(PUPPETEER_BROWSER)).error, undefined);
  assert.deepEqual(forwarded(p), [{ type: 'tab' }]);
  for (const filter of [[{}], PUPPETEER_BROWSER]) {
    assert.equal((await ask(filter, session)).error, undefined);
    assert.deepEqual(forwarded(p, session), [{ type: 'page' }, { type: 'iframe' }]);
  }
  const { attach } = frame(p, 'cross', CROSS, 'root', session);
  const child = await attach();
  assert.ok(shown(p, child), 'the ordinary cross-site iframe is shown');
  assert.equal((await ask([{}], child)).error, undefined);
  assert.deepEqual(forwarded(p, child), [{ type: 'page' }, { type: 'iframe' }]);
  assert.equal((await ask([{ type: 'iframe' }], session)).error, undefined);
  assert.deepEqual(forwarded(p, session), [{ type: 'iframe' }]);
  assert.equal((await ask(undefined, session)).error, undefined);
  assert.equal(forwarded(p, session), undefined);
});

test('an ordinary cross-site iframe is held until placed, then shown with its target info, and takes the group-1 setup calls', async (t) => {
  const { p, session } = await placedPage(t);
  const { attach } = frame(p, 'cross', CROSS, 'root', session);
  const child = await attach();
  assert.ok(resumed(p, child), 'the paused iframe runs');
  const attached = p.delivered.find(
    (message) => message.method === 'Target.attachedToTarget' && message.params?.sessionId === child
  );
  assert.equal(attached?.sessionId, session);
  assert.equal(attached.params.targetInfo.type, 'iframe');
  assert.equal(attached.params.targetInfo.url, CROSS);
  assert.ok(!cutInChrome(p, child));
  const init = await p.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: '//# sourceURL=pptr:internal', worldName: 'utility' },
    child
  );
  assert.equal(init.error, undefined);
  assert.equal(
    (await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }, child)).error,
    undefined
  );
  const before = p.sent.length;
  const world = await p.send(
    'Page.createIsolatedWorld',
    { frameId: 'cross', worldName: 'utility', grantUniveralAccess: true },
    child
  );
  assert.equal(world.error, undefined);
  const out = p.sent
    .slice(before)
    .find(
      (message) => message.method === 'Page.createIsolatedWorld' && message.sessionId === child
    );
  assert.equal(out.params.grantUniveralAccess, undefined);
  assert.match(
    (await p.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.x = 1' }, child)).error
      ?.message,
    /slicc: refused: scripts and bindings for later documents/
  );
});

test('a protected cross-site iframe inside an ordinary page is resumed, cut and never shown, listed or attachable', async (t) => {
  const { p, session } = await placedPage(t);
  const { attach } = frame(p, 'secret', SECRET, 'root', session);
  const child = await attach();
  await settle(200);
  assert.ok(!shown(p, child), 'the protected iframe is never shown');
  assert.ok(cutInChrome(p, child), 'the protected iframe is detached');
  assert.ok(resumed(p, child), 'the protected iframe is resumed before the cut');
  const listed = await p.send('Target.getTargets', {});
  assert.ok(
    !listed.result.targetInfos.some((info) => info.targetId === 'secret'),
    'the protected iframe is not listed'
  );
  assert.ok((await p.send('Target.getTargetInfo', { targetId: 'secret' })).error);
  assert.ok(
    (await p.send('Target.attachToTarget', { targetId: 'secret', flatten: true })).error,
    'attaching to it by id is refused'
  );
  assert.deepEqual(leaks(p, SECRET, '/vault/secret-frame'), []);
});

test('a shown ordinary iframe that navigates into a protected origin is cut', async (t) => {
  const { p, session } = await placedPage(t);
  const { target, attach } = frame(p, 'mover', CROSS, 'root', session);
  const child = await attach();
  assert.ok(shown(p, child));
  target.info.url = SECRET;
  target.tree.frame = { ...target.tree.frame, url: SECRET, securityOrigin: protectedOrigin };
  p.emit({
    sessionId: child,
    method: 'Page.frameNavigated',
    params: { frame: target.tree.frame, type: 'Navigation' },
  });
  await settle(200);
  assert.ok(detachedTo(p, child), 'the iframe session is cut');
  assert.ok(cutInChrome(p, child));
  assert.ok(!detachedTo(p, session), 'the ordinary page keeps its session');
  const read = await p.send('Runtime.evaluate', { expression: 'document.title' }, child);
  assert.ok(read.error);
  assert.ok((await p.send('Target.attachToTarget', { targetId: 'mover', flatten: true })).error);
  assert.deepEqual(leaks(p, SECRET), []);
});

test('a device filter with workers and pages on the browser session stays page-only', async (t) => {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), undefined, undefined, { kind: 'device', id: 'd' })
  );
  await p.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'worker' }, { type: 'page' }],
  });
  assert.deepEqual(forwarded(p), [{ type: 'page' }]);
});
