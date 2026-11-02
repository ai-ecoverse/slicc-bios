import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerScopeRead } from './cdp-675-worker-scope.mjs';

test('owned worker scope retries only a bounded slow pure read and retains each attempt', async () => {
  let time = 100;
  let attempts = 0;
  const row = { pause: { at: 0 } };
  const reply = { result: { value: true } };
  assert.equal(
    await workerScopeRead(
      async (milliseconds) => {
        attempts += 1;
        if (attempts === 1) {
          time += milliseconds;
          throw new Error(`raw Runtime.evaluate exceeded ${milliseconds}ms`);
        }
        time += 10;
        return reply;
      },
      row,
      () => time
    ),
    reply
  );
  assert.equal(row.workerScopeAttempts.length, 2);
  assert.equal(row.workerScopeDeadline, 3100);
  assert.equal(row.workerScopeAttempts[1].reply, reply);
  assert.equal(row.workerScopeAttempts[0].error, 'raw Runtime.evaluate exceeded 1000ms');
});

test('scope proof preserves a false reply and never retries a real refusal', async () => {
  const row = { pause: { at: 0 } };
  const reply = { result: { value: false } };
  assert.equal(
    await workerScopeRead(
      async () => reply,
      row,
      () => 10
    ),
    reply
  );
  assert.equal(row.workerScopeAttempts.length, 1);
  const error = new Error('slicc: refused');
  await assert.rejects(
    workerScopeRead(
      async () => {
        throw error;
      },
      row,
      () => 10
    ),
    (thrown) => thrown === error
  );
  assert.equal(row.workerScopeAttempts.length, 1);
});

test('scope retries stop at three attempts and reserve page progress time inside the original bound', async () => {
  for (const start of [100, 4700, 5000]) {
    let time = start;
    const row = { pause: { at: 0 } };
    await assert.rejects(
      workerScopeRead(
        async (milliseconds) => {
          time += milliseconds;
          throw new Error(`raw Runtime.evaluate exceeded ${milliseconds}ms`);
        },
        row,
        () => time
      ),
      /exhausted its bounded retries/
    );
    assert.ok(row.workerScopeAttempts.length <= 3);
    assert.ok(time <= 5000);
    if (start === 100) assert.equal(row.workerScopeAttempts.length, 3);
    if (start === 4700) assert.equal(row.workerScopeAttempts[0].milliseconds, 300);
    if (start === 5000) assert.equal(row.workerScopeAttempts.length, 0);
  }
});
