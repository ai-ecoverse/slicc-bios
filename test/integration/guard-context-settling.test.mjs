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

async function settling(t, refuses) {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), { kind: 'extension', version: '7.12.0' }, async () => null)
  );
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'old' });
  const session = await p.attach('root');
  assert.equal((await p.send('Runtime.enable', {}, session)).error, undefined);
  root.tree.frame.loaderId = 'new';
  const context = {
    id: 31,
    uniqueId: 'refused-root-context',
    name: '',
    origin: 'https://ordinary.invalid',
    auxData: { frameId: 'root', isDefault: true, type: 'default' },
  };
  let attempts = 0;
  let holdTrees = true;
  p.hold((message) => {
    if (message.id < 2 ** 30) return false;
    if (message.method === 'Page.getFrameTree') return holdTrees;
    if (
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
    context,
    attempts: () => attempts,
    async start() {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
      p.emit({
        sessionId: session,
        method: 'Page.frameNavigated',
        params: { frame: root.tree.frame },
      });
      p.emit({
        sessionId: session,
        method: 'Runtime.executionContextCreated',
        params: { context },
      });
      await flush();
      holdTrees = false;
      for (const held of [...p.held]) p.release(held);
      await flush();
    },
  };
}

test('settling probes recover on the timer without another frame or load event', async (t) => {
  const { p, session, attempts, start } = await settling(t, (attempt) => attempt < 3);
  await start();
  const pending = p.request('Debugger.enable', {}, session);
  await flush();
  t.mock.timers.tick(50);
  await flush();
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
  assert.equal(attempts(), 1);
  assert.equal(Date.now(), 50);
  t.mock.timers.tick(50);
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.equal((await pending.answer).error, undefined);
  assert.equal(Date.now(), 200);
  assert.equal(attempts(), 3);
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
});

test('persistent refusal becomes hidden within one second and preserves the two-second client budget', async (t) => {
  const { p, session, context, attempts, start } = await settling(t, () => true);
  await start();
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
  await advance(t, 100);
  assert.equal(Date.now(), 1000);
  assert.equal(settled, true);
  const runtimeAnswer = await runtime.answer;
  assert.ok(runtimeAnswer.error);
  assert.doesNotMatch(runtimeAnswer.error.message, /timed out/);
  assert.equal(attempts(), 10);
  t.mock.timers.tick(30);
  await flush();
  assert.equal(attempts(), 10);
  const answer = await p.send('Debugger.enable', {}, session);
  assert.match(answer.error?.message ?? '', /browser extension runs scripts/);
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
  assert.equal(
    p.delivered.some(({ params }) => params?.context?.uniqueId === context.uniqueId),
    false
  );
  const before = attempts();
  p.emit({ sessionId: session, method: 'Page.loadEventFired', params: { timestamp: 1 } });
  await advance(t, 100);
  t.mock.timers.tick(20);
  await flush();
  assert.equal(attempts(), before);
  assert.equal(Date.now(), 1150);
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /browser extension runs scripts/
  );
});
