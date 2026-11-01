import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

async function pendingContext(t) {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), { kind: 'extension', version: '7.10.1' }, async () => null)
  );
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'old' });
  const session = await p.attach('root');
  assert.equal((await p.send('Runtime.enable', {}, session)).error, undefined);
  root.tree.frame.loaderId = 'new';
  p.hold(
    ({ id, method, params }) =>
      id >= 2 ** 30 &&
      (method === 'Page.getFrameTree' ||
        (method === 'Runtime.evaluate' && params.expression === 'location.href'))
  );
  p.emit({ sessionId: session, method: 'Page.frameNavigated', params: { frame: root.tree.frame } });
  const context = {
    id: 31,
    uniqueId: 'root-new-context',
    name: '',
    origin: 'https://ordinary.invalid',
    auxData: { frameId: 'root', isDefault: true, type: 'default' },
  };
  p.emit({ sessionId: session, method: 'Runtime.executionContextCreated', params: { context } });
  await flush();
  const probe = p.held.find(
    ({ method, params }) =>
      method === 'Runtime.evaluate' && params.uniqueContextId === context.uniqueId
  );
  assert.ok(probe);
  p.release(probe, {
    error: { code: -32000, message: "slicc: refused: target is on seven's origin" },
  });
  await flush();
  return { p, root, session, context };
}

test('a settling refused root probe stays unusable and succeeds on the next load event', async (t) => {
  const { p, session, context } = await pendingContext(t);
  const since = p.sent.length;
  const read = p.request(
    'Runtime.evaluate',
    { expression: '42', uniqueContextId: context.uniqueId },
    session
  );
  let completed = false;
  void read.answer.then(() => {
    completed = true;
  });
  await flush();
  assert.equal(completed, false, 'unproved context is still being checked');
  assert.equal(
    p.clients(since).some(({ method }) => method === 'Runtime.evaluate'),
    false
  );
  assert.equal(
    p.delivered.some(({ method }) => method === 'Runtime.executionContextCreated'),
    false
  );
  p.hold(() => false);
  for (const message of [...p.held]) p.release(message);
  p.emit({ sessionId: session, method: 'Page.loadEventFired', params: { timestamp: 1 } });
  await flush();
  await flush();
  assert.equal((await read.answer).error, undefined);
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  assert.equal(
    p.delivered.filter(({ method }) => method === 'Runtime.executionContextCreated').length,
    1
  );
  assert.equal(
    p.sent.filter(
      ({ method, params }) =>
        method === 'Runtime.evaluate' &&
        params?.uniqueContextId === context.uniqueId &&
        params.expression === 'location.href'
    ).length,
    2
  );
});

test('a refused settling probe reaches the two-second bound, stays hidden, and cannot be revived by a load', async (t) => {
  const { p, session, context } = await pendingContext(t);
  const began = Date.now();
  const read = p.request(
    'Runtime.evaluate',
    { expression: '42', uniqueContextId: context.uniqueId },
    session
  );
  let completed = false;
  void read.answer.then(() => {
    completed = true;
  });
  await flush();
  assert.equal(completed, false, 'transient refusal cannot immediately classify the context');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.ok(Date.now() - began < 2600, 'settling proof exceeded its bound');
  assert.match((await read.answer).error?.message ?? '', /refused/);
  p.hold(() => false);
  for (const message of [...p.held]) p.release(message);
  p.emit({ sessionId: session, method: 'Page.loadEventFired', params: { timestamp: 2 } });
  await flush();
  assert.match(
    (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
    /browser extension runs scripts/
  );
  assert.equal(
    p.delivered.some(({ method }) => method === 'Runtime.executionContextCreated'),
    false
  );
  assert.equal(
    p.sent.filter(
      ({ method, params }) =>
        method === 'Runtime.evaluate' &&
        params?.uniqueContextId === context.uniqueId &&
        params.expression === 'location.href'
    ).length,
    1
  );
});
