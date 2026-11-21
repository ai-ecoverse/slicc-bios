import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

const ANSWER_MS = 1000;

async function advance(t, ms) {
  for (let left = ms; left > 0; left -= 25) {
    t.mock.timers.tick(Math.min(25, left));
    await flush();
  }
}

async function contextRow(t, { answer }) {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
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
    id: 71,
    uniqueId: 'unconfirmed-root-context',
    name: '',
    origin: new URL(ordinary).origin,
    auxData: { frameId: 'root', isDefault: true, type: 'default' },
  };
  const checks = [];
  p.hold((message) => {
    if (
      message.id < 2 ** 30 ||
      message.method !== 'Runtime.evaluate' ||
      message.params.uniqueContextId !== context.uniqueId
    )
      return false;
    checks.push(message);
    return !answer;
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  p.emit({ sessionId: session, method: 'Runtime.executionContextCreated', params: { context } });
  await flush();
  const created = () =>
    p.delivered.some(
      (message) =>
        message.method === 'Runtime.executionContextCreated' &&
        message.params?.context?.id === context.id
    );
  return { checks, warnings, created };
}

test('a default context whose location check times out is logged as unconfirmed and its dropped event names the timeout', async (t) => {
  const { checks, warnings, created } = await contextRow(t, { answer: false });
  assert.equal(checks.length, 1, 'the guard asked the context for its location');
  await advance(t, ANSWER_MS - 25);
  assert.deepEqual(warnings, [], 'nothing is logged before the answer budget ends');
  await advance(t, 50);
  assert.deepEqual(warnings, [
    `the CDP guard could not confirm a context: target root, context 71, timeout, ${ANSWER_MS} ms of ${ANSWER_MS} ms`,
    `the CDP guard dropped Runtime.executionContextCreated: target root, context 71, timeout, ${ANSWER_MS} ms of ${ANSWER_MS} ms`,
  ]);
  assert.equal(created(), false, 'the client never saw the context');
});

test('a default context whose location check answers logs nothing and reaches the client', async (t) => {
  const { checks, warnings, created } = await contextRow(t, { answer: true });
  await advance(t, ANSWER_MS + 25);
  assert.equal(checks.length, 1, 'the guard asked the context for its location');
  assert.deepEqual(warnings, []);
  assert.equal(created(), true, 'the client saw the context');
});
