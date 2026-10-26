import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

test('a positive read that omits protected unreachableUrl retires the historical private commit', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('live');
  const session = await wire.attach('live');
  await wire.send('Runtime.evaluate', { expression: '1' }, session);
  const protectedFrame = {
    ...plainFrame('live'),
    loaderId: 'synthetic-loader',
    unreachableUrl: failed,
  };
  entry.tree = { frame: protectedFrame };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: protectedFrame, type: 'Navigation' },
  });
  assert.match(
    (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error?.message ?? '',
    /^slicc: refused:/,
    'the protected failed URL is independently recognized'
  );
  entry.tree = { frame: { ...plainFrame('live'), loaderId: 'synthetic-loader' } };
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
    undefined,
    'the complete ordinary snapshot without the failed URL recovers'
  );
  entry.tree = { frame: protectedFrame };
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Runtime.evaluate');
  const mark = wire.sent.length;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: protectedFrame, type: 'Navigation' },
  });
  const reading = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
  await flush();
  const forwarded = wire.held.find((message) => message.id === reading.id);
  if (forwarded) wire.release(forwarded, { result: { result: { value: failed } } });
  const answer = await reading.answer;
  assert.equal(
    JSON.stringify(wire.delivered).includes(failed),
    false,
    'the repeated private commit cannot reuse the intervening positive content admission'
  );
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
  assert.equal(
    wire.clients(mark).some((message) => message.id === reading.id),
    false
  );
});
