import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

async function advance(t, ms) {
  for (let left = ms; left > 0; left -= 100) {
    t.mock.timers.tick(100);
    await flush();
  }
}

async function readyProof(t, refuses) {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), { kind: 'extension', version: '7.12.0' }, async () => null)
  );
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'old' });
  const session = await p.attach('root');
  assert.equal((await p.send('Runtime.enable', {}, session)).error, undefined);
  root.tree.frame.loaderId = 'new';
  p.emit({ sessionId: session, method: 'Page.frameNavigated', params: { frame: root.tree.frame } });
  await flush();
  const context = {
    id: 61,
    uniqueId: 'ready-root-context',
    name: '',
    origin: 'https://ordinary.invalid',
    auxData: { frameId: 'root', isDefault: true, type: 'default' },
  };
  let attempts = 0;
  p.hold((message) => {
    if (
      message.id < 2 ** 30 ||
      message.method !== 'Runtime.evaluate' ||
      message.params.uniqueContextId !== context.uniqueId
    )
      return false;
    attempts += 1;
    if (!refuses(attempts)) return false;
    queueMicrotask(() =>
      p.release(message, {
        error: { code: -32000, message: "slicc: refused: target is on seven's origin" },
      })
    );
    return true;
  });
  return {
    p,
    session,
    attempts: () => attempts,
    start() {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
      p.emit({
        sessionId: session,
        method: 'Runtime.executionContextCreated',
        params: { context },
      });
    },
  };
}

test('a ready frame tree does not turn a transient default-context proof refusal into a terminal Runtime.enable refusal', async (t) => {
  const { p, session, attempts, start } = await readyProof(t, (attempt) => attempt === 1);
  start();
  const before = p.clients().length;
  const runtime = p.request('Runtime.enable', {}, session);
  await flush();
  assert.equal(
    p
      .clients()
      .slice(before)
      .some(({ method }) => method === 'Runtime.enable'),
    false
  );
  assert.equal(attempts(), 1);
  assert.equal(Date.now(), 0);
  t.mock.timers.tick(50);
  await flush();
  assert.equal(
    p
      .clients()
      .slice(before)
      .some(({ method }) => method === 'Runtime.enable'),
    false
  );
  assert.equal(attempts(), 1);
  assert.equal(Date.now(), 50);
  t.mock.timers.tick(50);
  await flush();
  assert.equal((await runtime.answer).error, undefined);
  assert.equal(attempts(), 2);
  assert.equal(Date.now(), 100);
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
});

test('a permanently refused ready default context stays terminal within the same one-second proof budget', async (t) => {
  const { p, session, attempts, start } = await readyProof(t, () => true);
  start();
  const before = p.clients().length;
  const runtime = p.request('Runtime.enable', {}, session);
  let settled = false;
  void runtime.answer.then(() => {
    settled = true;
  });
  await flush();
  await advance(t, 900);
  assert.equal(Date.now(), 900);
  assert.equal(attempts(), 10);
  assert.equal(settled, false);
  assert.equal(
    p
      .clients()
      .slice(before)
      .some(({ method }) => method === 'Runtime.enable'),
    false
  );
  await advance(t, 100);
  assert.equal(Date.now(), 1000);
  assert.equal(settled, true);
  assert.ok((await runtime.answer).error);
  assert.equal(
    p
      .clients()
      .slice(before)
      .some(({ method }) => method === 'Runtime.enable'),
    false
  );
  assert.equal(attempts(), 10);
  await advance(t, 100);
  assert.equal(attempts(), 10);
  assert.equal(Date.now(), 1100);
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /browser extension runs scripts/
  );
});
