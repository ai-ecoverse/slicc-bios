import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, protocol } from './guard-ordering-fixture.mjs';

test('ordering duplicate reservation', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.target('reservation');
  const session = await wire.attach('reservation');
  wire.target('delayed-info');
  const last = Math.max(...wire.sent.map((message) => message.id));
  const callerId = last + 2;
  wire.hold(
    (message) =>
      (message.method === 'Target.getTargetInfo' &&
        message.id >= 2 ** 30 &&
        message.params.targetId === 'delayed-info') ||
      (message.method === 'Page.getFrameTree' && message.sessionId === 'guard-reservation') ||
      message.method === 'Browser.getVersion'
  );
  const blocker = wire.request('Target.getTargetInfo', { targetId: 'delayed-info' });
  await flush();
  const lookup = wire.held.find((message) => message.method === 'Target.getTargetInfo');
  assert.equal(lookup?.id, last + 1);
  wire.request('Browser.getVersion', {}, undefined, callerId);
  const duplicate = wire.request('Tracing.start', {}, session, callerId);
  assert.match((await duplicate.answer).error?.message ?? '', /^slicc: refused:/);
  const reading = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
  await flush();
  const privateCall = wire.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(privateCall);
  wire.release(lookup);
  assert.equal((await blocker.answer).error, undefined);
  await flush();
  const browser = wire.held.find((message) => message.method === 'Browser.getVersion');
  assert.ok(browser);
  wire.release(browser, { result: { product: 'synthetic-browser' } });
  await flush();
  wire.release(privateCall, { result: { frameTree: { frame: errorFrame('reservation') } } });
  assert.match((await reading.answer).error?.message ?? '', /^slicc: refused:/);
  await flush();
  assert.equal(JSON.stringify(wire.delivered).includes(failed), false, 'the reply stays isolated');
  assert.notEqual(privateCall.id, callerId);
  assert.deepEqual(
    wire.sent.filter((message) => message.id === callerId).map((message) => message.method),
    ['Browser.getVersion']
  );
  assert.ok(
    wire.delivered.some(
      (message) => message.id === callerId && message.result?.product === 'synthetic-browser'
    )
  );
});
