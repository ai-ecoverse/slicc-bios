import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protocol } from './guard-ordering-fixture.mjs';

test('ordering reply control', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const reply = wire.request('Browser.getVersion', {}, undefined, 2 ** 30 + 100000);
  const answer = await reply.answer;
  assert.equal(answer.id, reply.id);
  assert.equal(answer.error, undefined);
  assert.deepEqual(answer.result, {});
});
