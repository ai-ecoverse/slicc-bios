import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const extension = { kind: 'extension', version: '7.12.2' };
const snapshot = () => ({
  version: 1,
  revision: 0,
  rootFrameId: 'root',
  rootLoaderId: 'loader',
  rootDocumentId: 'native',
  remoteOwners: [],
  frames: [
    { frameId: 0, parentFrameId: -1, documentId: 'native', url: 'https://ordinary.invalid/page' },
  ],
});
const internal = (message) => message.id >= 2 ** 30;
const owned = (p, method) =>
  p.sent.filter(
    (message) =>
      internal(message) && message.method === method && message.sessionId === 'guard-root'
  ).length;

async function settle() {
  for (let i = 0; i < 20; i += 1) await flush();
}

async function armed(t, route = extension) {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), route, async () => snapshot())
  );
  p.target('root', 'page', { ...plainFrame('root'), loaderId: 'loader' });
  const session = await p.attach('root');
  await settle();
  return { p, session };
}

const bump = (p) =>
  p.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: p.targets.get('root').info },
  });

const replace = (p, session) => {
  const target = p.targets.get('root');
  target.tree = { frame: target.tree.frame, childFrames: [{ frame: plainFrame('child', 'root') }] };
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'child', parentFrameId: 'root' },
  });
};

const evaluate = (p, session) => p.send('Debugger.enable', {}, session);

async function placing(p, method, session, each) {
  let seen = 0;
  p.hold(
    (message) =>
      internal(message) &&
      message.method === method &&
      message.sessionId === 'guard-root' &&
      seen++ >= 0
  );
  replace(p, session);
  for (let step = 0; step < 6; step += 1) {
    await settle();
    const message = p.held.find((held) => held.method === method);
    if (!message) break;
    await each(message, step);
  }
  p.hold(() => false);
  await settle();
}

test('a revision bump during placement is re-placed once and the page is ready', async (t) => {
  const { p, session } = await armed(t);
  const before = owned(p, 'DOMSnapshot.captureSnapshot');
  await placing(p, 'DOMSnapshot.captureSnapshot', session, (message, step) => {
    if (step === 0) bump(p);
    p.release(message);
  });
  assert.equal(owned(p, 'DOMSnapshot.captureSnapshot') - before, 2);
  assert.equal((await evaluate(p, session)).error, undefined);
});

test('continuous bumps stop after one retry pair and the page fails closed', async (t) => {
  const { p, session } = await armed(t);
  const before = owned(p, 'DOMSnapshot.captureSnapshot');
  await placing(p, 'DOMSnapshot.captureSnapshot', session, (message) => {
    bump(p);
    p.release(message);
  });
  assert.equal(owned(p, 'DOMSnapshot.captureSnapshot') - before, 3);
  assert.equal((await evaluate(p, session)).error?.message, PROTECTED);
});

test('a placement past its deadline is not retried and fails closed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { p, session } = await armed(t);
  const before = owned(p, 'DOMSnapshot.captureSnapshot');
  await placing(p, 'DOMSnapshot.captureSnapshot', session, (message) => {
    bump(p);
    t.mock.timers.tick(2000);
    p.release(message);
  });
  assert.equal(owned(p, 'DOMSnapshot.captureSnapshot') - before, 1);
  assert.equal((await evaluate(p, session)).error?.message, PROTECTED);
});

test('the retry reuses the first deadline instead of starting a new one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { p, session } = await armed(t);
  const before = owned(p, 'DOMSnapshot.captureSnapshot');
  await placing(p, 'DOMSnapshot.captureSnapshot', session, (message, step) => {
    bump(p);
    t.mock.timers.tick(step === 0 ? 1000 : 1001);
    p.release(message);
  });
  assert.equal(owned(p, 'DOMSnapshot.captureSnapshot') - before, 2);
  assert.equal((await evaluate(p, session)).error?.message, PROTECTED);
});

test('a real call error is not retried', async (t) => {
  const { p, session } = await armed(t);
  const before = owned(p, 'DOMSnapshot.captureSnapshot');
  await placing(p, 'DOMSnapshot.captureSnapshot', session, (message) => {
    bump(p);
    p.release(message, { error: { code: -32000, message: 'synthetic snapshot failure' } });
  });
  assert.equal(owned(p, 'DOMSnapshot.captureSnapshot') - before, 1);
  assert.equal((await evaluate(p, session)).error?.message, PROTECTED);
});

test('owners not ready fails closed without a retry', async (t) => {
  const { p, session } = await armed(t);
  const before = owned(p, 'DOMSnapshot.captureSnapshot');
  await placing(p, 'DOMSnapshot.captureSnapshot', session, (message) => {
    p.release(message, { result: { documents: [], strings: [] } });
  });
  assert.equal(owned(p, 'DOMSnapshot.captureSnapshot') - before, 1);
  assert.equal((await evaluate(p, session)).error?.message, PROTECTED);
});

test('a non-extension route places once and ignores revision bumps', async (t) => {
  const { p, session } = await armed(t, { kind: 'link', version: '1.60.0' });
  const before = owned(p, 'DOM.getDocument');
  await placing(p, 'DOM.getDocument', session, (message) => {
    bump(p);
    p.release(message);
  });
  assert.equal(owned(p, 'DOM.getDocument') - before, 1);
  assert.equal((await evaluate(p, session)).error, undefined);
});

test('a page that turns protected still locks after the retry', async (t) => {
  const { p, session } = await armed(t);
  await placing(p, 'DOMSnapshot.captureSnapshot', session, (message, step) => {
    if (step === 0) {
      const target = p.targets.get('root');
      target.tree = { frame: plainFrame('root') };
      target.tree.frame.url = `${protectedOrigin}/controller/page`;
      target.tree.frame.securityOrigin = protectedOrigin;
      bump(p);
    }
    p.release(message);
  });
  assert.equal((await evaluate(p, session)).error?.message, PROTECTED);
});

test('a page-scoped command waits for the retry before it is answered', async (t) => {
  const { p, session } = await armed(t);
  let command;
  await placing(p, 'DOMSnapshot.captureSnapshot', session, async (message, step) => {
    if (step === 0) {
      command = p.request('Debugger.enable', {}, session);
      bump(p);
      await settle();
      assert.equal(
        p.delivered.some(({ id }) => id === command.id),
        false
      );
    }
    p.release(message);
  });
  assert.equal((await command.answer).error, undefined);
});

test('a placement requested while one runs gets its own fresh pass after the retry', async (t) => {
  const { p, session } = await armed(t);
  const before = owned(p, 'DOMSnapshot.captureSnapshot');
  await placing(p, 'DOMSnapshot.captureSnapshot', session, (message, step) => {
    if (step === 0) replace(p, session);
    p.release(message);
  });
  assert.equal(owned(p, 'DOMSnapshot.captureSnapshot') - before, 3);
  assert.equal((await evaluate(p, session)).error, undefined);
});
