import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

async function readyProof(t, refuses) {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), { kind: 'extension', version: '7.11.99' }, async () => null)
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
  p.emit({ sessionId: session, method: 'Runtime.executionContextCreated', params: { context } });
  return { p, session, attempts: () => attempts };
}

test('a ready frame tree does not turn a transient default-context proof refusal into a terminal Runtime.enable refusal', async (t) => {
  const { p, session, attempts } = await readyProof(t, (attempt) => attempt === 1);
  const before = p.clients().length;
  const runtime = p.request('Runtime.enable', {}, session);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    p
      .clients()
      .slice(before)
      .some(({ method }) => method === 'Runtime.enable'),
    false
  );
  assert.equal((await runtime.answer).error, undefined);
  assert.equal(attempts(), 2);
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
});

test('a permanently refused ready default context stays terminal within the same one-second proof budget', async (t) => {
  const { p, session, attempts } = await readyProof(t, () => true);
  const before = p.clients().length;
  const started = performance.now();
  assert.ok((await p.send('Runtime.enable', {}, session)).error);
  assert.equal(
    p
      .clients()
      .slice(before)
      .some(({ method }) => method === 'Runtime.enable'),
    false
  );
  const spent = performance.now() - started;
  assert.ok(spent >= 900 && spent < 1600, `${spent}ms`);
  assert.ok(attempts() >= 8 && attempts() <= 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /browser extension runs scripts/
  );
});
