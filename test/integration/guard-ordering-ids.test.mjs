import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, protocol } from './guard-ordering-fixture.mjs';

const refusal = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};
const privateTree = (id) => ({ result: { frameTree: { frame: errorFrame(id) } } });
const version = { result: { product: 'synthetic-browser' } };
const hold = (message) =>
  message.method === 'Browser.getVersion' ||
  (message.sessionId?.startsWith('guard-') && message.method === 'Page.getFrameTree');

test('ordering expired reply identifier', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.target('expired');
  const session = await wire.attach('expired');
  wire.hold(hold);
  const reading = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
  await flush();
  const probe = wire.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(probe);
  const watchdog = setTimeout(() => assert.fail('the independent check did not settle'), 3000);
  t.after(() => clearTimeout(watchdog));
  refusal(await reading.answer);
  clearTimeout(watchdog);
  const caller = wire.request('Browser.getVersion', {}, undefined, probe.id);
  await flush();
  const actual = wire.held.find((message) => message.method === 'Browser.getVersion');
  wire.release(probe, privateTree('expired'));
  const answer = await caller.answer;
  if (actual) wire.release(actual, version);
  await flush();
  refusal(answer);
  assert.equal(
    wire.sent.some((message) => message.method === 'Browser.getVersion' && message.id === probe.id),
    false,
    'a reserved caller identifier is never forwarded'
  );
  assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
});

for (const state of ['active', 'queued']) {
  test(`ordering caller identifier ${state}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('allocation');
    const session = await wire.attach('allocation');
    wire.hold(hold);
    const next = Math.max(...wire.sent.map((message) => message.id)) + 1;
    const caller = wire.request('Browser.getVersion', {}, undefined, next);
    if (state === 'active') await flush();
    const reading = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
    await flush();
    const actual = wire.held.find((message) => message.method === 'Browser.getVersion');
    const probe = wire.held.find((message) => message.method === 'Page.getFrameTree');
    assert.ok(actual);
    assert.ok(probe);
    wire.release(actual, version);
    await flush();
    wire.release(probe, privateTree('allocation'));
    const [answer, read] = await Promise.all([caller.answer, reading.answer]);
    assert.notEqual(probe.id, caller.id, 'the private check never allocates a caller identifier');
    assert.deepEqual(
      wire.sent.filter((message) => message.id === caller.id).map((message) => message.method),
      ['Browser.getVersion']
    );
    assert.deepEqual(answer.result, version.result);
    refusal(read);
    assert.equal(
      wire.clients().some((message) => message.id === reading.id),
      false
    );
    assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
  });
}
