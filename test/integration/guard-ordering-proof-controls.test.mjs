import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const securityOrigin of ['', new URL(ordinary).origin]) {
  test(`residual loading child requires a fresh committed tree ${securityOrigin || 'empty origin'}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('loading-owner');
    const loading = { ...plainFrame('loading-child', 'loading-owner'), url: '', securityOrigin };
    entry.tree.childFrames = [{ frame: loading }];
    wire.hold(
      (message) =>
        message.method === 'Page.getFrameTree' && message.sessionId === 'client-loading-owner'
    );
    const attachment = wire.request('Target.attachToTarget', {
      targetId: 'loading-owner',
      flatten: true,
    });
    await flush();
    const pending = wire.held.find((message) => message.sessionId === 'client-loading-owner');
    assert.ok(pending);
    wire.release(pending);
    await flush();
    assert.equal(
      wire.delivered.some((message) => message.id === attachment.id),
      false,
      'an empty child is not positive document evidence'
    );
    wire.hold(() => false);
    entry.tree.childFrames = [{ frame: plainFrame('loading-child', 'loading-owner') }];
    const answer = await attachment.answer;
    assert.equal(answer.error, undefined);
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, answer.result.sessionId)).error,
      undefined
    );
  });
}

test('residual an unanswered document proof refuses without blocking another target', {
  timeout: 3500,
}, async (t) => {
  const wire = protocol(t);
  t.after(() => {
    wire.hold(() => false);
    for (const held of [...wire.held]) wire.release(held);
  });
  wire.target('unanswered-proof');
  wire.target('unrelated-proof');
  wire.hold(
    (message) =>
      message.method === 'Page.getFrameTree' && message.sessionId === 'client-unanswered-proof'
  );
  const started = Date.now();
  const pending = wire.request('Target.attachToTarget', {
    targetId: 'unanswered-proof',
    flatten: true,
  });
  await flush();
  const other = await wire.attach('unrelated-proof');
  assert.equal((await wire.send('Runtime.evaluate', { expression: '1' }, other)).error, undefined);
  const answer = await pending.answer;
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
  assert.ok(Date.now() - started < 2500);
});

test('residual an unanswered context proof refuses an older read at its deadline', {
  timeout: 3500,
}, async (t) => {
  const wire = protocol(t);
  t.after(() => {
    wire.hold(() => false);
    for (const held of [...wire.held]) wire.release(held);
  });
  wire.target('context-owner');
  const session = await wire.attach('context-owner');
  await wire.send('Runtime.enable', {}, session);
  wire.hold(
    (message) =>
      message.id >= 2 ** 30 &&
      message.method === 'Runtime.evaluate' &&
      message.params.expression === 'location.href'
  );
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 59,
        origin: new URL(ordinary).origin,
        auxData: { frameId: 'context-owner', isDefault: true, type: 'default' },
      },
    },
  });
  await flush();
  const started = Date.now();
  const read = await wire.send('Runtime.evaluate', { expression: '1' }, session);
  assert.match(read.error?.message ?? '', /^slicc: refused:/);
  assert.equal(read.result, undefined);
  assert.ok(Date.now() - started < 2500);
});
