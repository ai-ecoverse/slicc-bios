import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

async function settling(t, refuses) {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), { kind: 'extension', version: '7.11.1' }, async () => null)
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
  p.emit({ sessionId: session, method: 'Page.frameNavigated', params: { frame: root.tree.frame } });
  p.emit({ sessionId: session, method: 'Runtime.executionContextCreated', params: { context } });
  await flush();
  holdTrees = false;
  for (const held of [...p.held]) p.release(held);
  return { p, session, context, attempts: () => attempts };
}

test('settling probes recover on the timer without another frame or load event', async (t) => {
  const { p, session, context, attempts } = await settling(t, (attempt) => attempt < 3);
  const start = performance.now();
  const pending = p.request('Debugger.enable', {}, session);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    p.clients().some(({ method }) => method === 'Debugger.enable'),
    false
  );
  assert.equal((await pending.answer).error, undefined);
  assert.ok(performance.now() - start < 1500);
  assert.equal(attempts(), 3);
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
});

test('persistent refusal becomes hidden within one second and preserves the two-second client budget', async (t) => {
  const { p, session, context, attempts } = await settling(t, () => true);
  const start = performance.now();
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
  const spent = performance.now() - start;
  assert.ok(
    spent >= 900 && spent < 1600,
    `${spent} ms exceeds the Rust DOCUMENT_CHECK budget margin`
  );
  assert.ok(attempts() >= 8 && attempts() <= 10);
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
