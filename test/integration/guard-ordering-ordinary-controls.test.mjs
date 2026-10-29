import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);

for (const type of ['page', 'worker', 'service_worker', 'shared_worker']) {
  test(`residual ordinary ${type} remains drivable`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('ordinary', type);
    const session = await wire.attach('ordinary');
    assert.equal((await read(wire, session)).error, undefined);
    const mark = wire.sent.length;
    assert.equal((await read(wire, session)).error, undefined);
    assert.equal(
      wire.sent
        .slice(mark)
        .some(
          (message) =>
            message.method === 'Page.getFrameTree' && message.sessionId === 'guard-ordinary'
        ),
      false
    );
  });
}

test('residual ordinary client notice preserves an outstanding read', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('ordinary');
  const session = await wire.attach('ordinary');
  await read(wire, session);
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Runtime.evaluate');
  const request = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
  await flush();
  const pending = wire.held.find((message) => message.id === request.id);
  assert.ok(pending);
  wire.sessions.set('second', 'ordinary');
  wire.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'second', targetInfo: entry.info, waitingForDebugger: false },
  });
  await flush();
  wire.release(pending);
  assert.equal((await request.answer).error, undefined);
});

test('residual ordinary context and console events remain observable', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.target('ordinary');
  const session = await wire.attach('ordinary');
  await wire.send('Runtime.enable', {}, session);
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 8,
        uniqueId: 'synthetic-ordinary-context',
        origin: new URL(ordinary).origin,
        name: '',
        auxData: { frameId: 'ordinary', isDefault: true, type: 'default' },
      },
    },
  });
  await flush();
  wire.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId: session,
    params: {
      type: 'log',
      executionContextId: 8,
      args: [{ type: 'string', value: 'synthetic-ordinary-console' }],
      timestamp: 1,
    },
  });
  await flush();
  assert.ok(wire.delivered.some((message) => message.method === 'Runtime.executionContextCreated'));
  assert.ok(JSON.stringify(wire.delivered).includes('synthetic-ordinary-console'));
  assert.equal((await read(wire, session)).error, undefined);
});

test('residual empty ordinary metadata uses a positive owned tree', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('ordinary');
  entry.info.url = '';
  const answer = await wire.send('Target.attachToTarget', { targetId: 'ordinary', flatten: true });
  assert.equal(answer.error, undefined);
  assert.equal((await read(wire, answer.result.sessionId)).error, undefined);
});

test('residual removed ordinary child leaves its parent usable', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('ordinary');
  const session = await wire.attach('ordinary');
  const frame = plainFrame('child', 'ordinary');
  entry.tree.childFrames = [{ frame }];
  wire.target('child', 'iframe', frame, 'ordinary');
  const child = wire.attached('child', session);
  await flush();
  await flush();
  assert.equal((await read(wire, child)).error, undefined);
  delete entry.tree.childFrames;
  wire.emit({
    method: 'Page.frameDetached',
    sessionId: session,
    params: { frameId: 'child', reason: 'remove' },
  });
  assert.equal((await read(wire, session)).error, undefined);
});
