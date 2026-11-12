import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

const CONTEXT_SETTLE_MS = 1000;
const CONTEXT_SETTLE_POLL_MS = 100;
const CONTEXT_SETTLE_ATTEMPTS = Math.ceil(CONTEXT_SETTLE_MS / CONTEXT_SETTLE_POLL_MS);

async function advance(t, ms) {
  for (let left = ms; left > 0; left -= 25) {
    t.mock.timers.tick(Math.min(25, left));
    await flush();
  }
}

async function settling(t, refuses, { mock = true } = {}) {
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
      if (mock) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
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
  await advance(t, 50);
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
  assert.equal(attempts(), 1);
  assert.equal(Date.now(), 50);
  await advance(t, 50);
  await advance(t, 100);
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
  await advance(t, CONTEXT_SETTLE_MS - CONTEXT_SETTLE_POLL_MS);
  assert.equal(Date.now(), CONTEXT_SETTLE_MS - CONTEXT_SETTLE_POLL_MS);
  assert.equal(attempts(), CONTEXT_SETTLE_ATTEMPTS);
  assert.equal(settled, false);
  await advance(t, CONTEXT_SETTLE_POLL_MS);
  assert.equal(Date.now(), CONTEXT_SETTLE_MS);
  assert.equal(settled, true);
  const runtimeAnswer = await runtime.answer;
  assert.ok(runtimeAnswer.error);
  assert.doesNotMatch(runtimeAnswer.error.message, /timed out/);
  assert.equal(attempts(), CONTEXT_SETTLE_ATTEMPTS);
  await advance(t, 30);
  assert.equal(attempts(), CONTEXT_SETTLE_ATTEMPTS);
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
  await advance(t, 120);
  assert.equal(attempts(), before);
  assert.equal(Date.now(), 1150);
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /browser extension runs scripts/
  );
});

test('real-clock smoke: settling probes recover without another frame or load event', async (t) => {
  const { p, session, attempts, start } = await settling(t, (attempt) => attempt < 3, {
    mock: false,
  });
  const began = performance.now();
  await start();
  const pending = p.request('Debugger.enable', {}, session);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
  assert.equal((await pending.answer).error, undefined);
  assert.ok(performance.now() - began < 1500);
  assert.equal(attempts(), 3);
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
});

test('real-clock smoke: persistent refusal becomes hidden within one second and preserves the two-second client budget', async (t) => {
  const { p, session, context, attempts, start } = await settling(t, () => true, { mock: false });
  const began = performance.now();
  await start();
  const runtime = await p.send('Runtime.enable', {}, session);
  assert.ok(runtime.error);
  assert.doesNotMatch(runtime.error.message, /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const answer = await p.send('Debugger.enable', {}, session);
  assert.match(answer.error?.message ?? '', /browser extension runs scripts/);
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
  const spent = performance.now() - began;
  assert.ok(spent >= 900 && spent < 1600, `${spent} ms`);
  const maxAttempts = Math.min(
    CONTEXT_SETTLE_ATTEMPTS,
    1 + Math.floor(spent / CONTEXT_SETTLE_POLL_MS)
  );
  assert.ok(attempts() >= 2 && attempts() <= maxAttempts);
  assert.equal(
    p.delivered.some(({ params }) => params?.context?.uniqueId === context.uniqueId),
    false
  );
  const before = attempts();
  p.emit({ sessionId: session, method: 'Page.loadEventFired', params: { timestamp: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(attempts(), before);
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /browser extension runs scripts/
  );
});
