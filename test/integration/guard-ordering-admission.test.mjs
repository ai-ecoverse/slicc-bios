import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const context = (id) => ({
  context: {
    id,
    uniqueId: `synthetic-ordinary-context-${id}`,
    origin: new URL(ordinary).origin,
    name: '',
    auxData: { isDefault: true, type: 'default', frameId: 'ordinary' },
  },
});

for (const method of ['Runtime.executionContextCreated', 'Runtime.consoleAPICalled']) {
  test(`ordering ordinary initial subscription ${method}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('ordinary');
    const session = await wire.attach('ordinary');
    assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);
    const mark = wire.delivered.length;
    wire.emit({
      method,
      sessionId: session,
      params:
        method === 'Runtime.executionContextCreated'
          ? context(101)
          : {
              type: 'log',
              args: [{ type: 'string', value: 'synthetic-ordinary-initial-console' }],
            },
    });
    await flush();
    const messages = wire.delivered.slice(mark).filter((message) => message.method === method);
    assert.equal(
      messages.length,
      1,
      'a positively checked attachment publishes ordinary initial Runtime notifications without another content read'
    );
  });
}

test('ordering ordinary context after commit requires current private classification', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('ordinary');
  const session = await wire.attach('ordinary');
  await wire.send('Runtime.enable', {}, session);
  wire.hold(
    (message) => message.sessionId === 'guard-ordinary' && message.method === 'Page.getFrameTree'
  );
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-ordinary',
    params: { frame: plainFrame('ordinary') },
  });
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: context(102),
  });
  await flush();
  assert.equal(
    wire.delivered
      .slice(mark)
      .some((message) => message.method === 'Runtime.executionContextCreated'),
    false
  );
  const proof = wire.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(proof, 'the notification waits for an independent current-document classification');
  wire.release(proof);
  await flush();
  assert.equal(
    wire.delivered
      .slice(mark)
      .filter((message) => message.method === 'Runtime.executionContextCreated').length,
    1
  );
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-ordinary',
    params: { frame: entry.tree.frame },
  });
  const negativeMark = wire.delivered.length;
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: context(103),
  });
  await flush();
  wire.release(
    wire.held.find((message) => message.method === 'Page.getFrameTree'),
    { error: { code: -32000, message: 'synthetic negative current classification' } }
  );
  await flush();
  assert.equal(
    wire.delivered
      .slice(negativeMark)
      .some((message) => message.method === 'Runtime.executionContextCreated'),
    false
  );
});

test('ordering unknown attachment is withheld without permanently classifying it as protected', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.target('ordinary');
  const session = 'client-ordinary';
  wire.sessions.set(session, 'ordinary');
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: session,
      targetInfo: { type: 'page', url: ordinary },
      waitingForDebugger: false,
    },
  });
  await flush();
  await flush();
  assert.equal(
    wire.delivered.some((message) => message.method === 'Target.attachedToTarget'),
    false
  );
  assert.equal(
    wire.sent.some(
      (message) =>
        message.method === 'Target.detachFromTarget' && message.params.sessionId === session
    ),
    false
  );
  const mark = wire.sent.length;
  const unconfirmed = await wire.send('Runtime.evaluate', { expression: '1' }, session);
  assert.match(unconfirmed.error?.message ?? '', /^slicc: refused:/);
  assert.deepEqual(wire.clients(mark), []);
  wire.attached('ordinary');
  await flush();
  await flush();
  const recovered = await wire.send('Runtime.evaluate', { expression: '1' }, session);
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.result?.result?.value, 'synthetic-content');
});
