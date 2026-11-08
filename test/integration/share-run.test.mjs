import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shareRun } from '../../src/seed/refused-start.js';

test('overlapping shareRun calls return the same promise', async () => {
  const gate = Promise.withResolvers();
  const run = shareRun(async () => {
    await gate.promise;
    return 'done';
  });
  const first = run();
  const second = run();
  assert.equal(first, second);
  gate.resolve();
  assert.equal(await first, 'done');
  assert.equal(await second, 'done');
});

test('many overlaps schedule exactly one follow-up after settle', async () => {
  let runs = 0;
  const gate = Promise.withResolvers();
  const follow = Promise.withResolvers();
  const run = shareRun(async () => {
    runs += 1;
    if (runs === 1) {
      await gate.promise;
      return 'first';
    }
    setImmediate(() => follow.resolve(runs));
    return 'follow';
  });
  const first = run();
  void run();
  void run();
  void run();
  assert.equal(runs, 1);
  gate.resolve();
  assert.equal(await first, 'first');
  assert.equal(await follow.promise, 2);
  assert.equal(runs, 2);
});

test('a call after settle starts a fresh run', async () => {
  let runs = 0;
  const run = shareRun(async () => {
    runs += 1;
    return runs;
  });
  assert.equal(await run(), 1);
  assert.equal(await run(), 2);
});

test('a rejected run clears and an overlap still gets one follow-up', async () => {
  let runs = 0;
  const gate = Promise.withResolvers();
  const follow = Promise.withResolvers();
  const run = shareRun(async () => {
    runs += 1;
    if (runs === 1) {
      await gate.promise;
      throw new Error('boom');
    }
    if (runs === 2) setImmediate(() => follow.resolve(runs));
    return runs;
  });
  const first = run();
  void run();
  gate.resolve();
  await assert.rejects(first, /boom/);
  assert.equal(await follow.promise, 2);
  assert.equal(await run(), 3);
});

test('the first call’s arguments are used for the run and the follow-up', async () => {
  const seen = [];
  const gate = Promise.withResolvers();
  const follow = Promise.withResolvers();
  const run = shareRun(async (value) => {
    seen.push(value);
    if (seen.length === 1) {
      await gate.promise;
      return value;
    }
    setImmediate(() => follow.resolve(value));
    return value;
  });
  const first = run('kept');
  const second = run('ignored');
  assert.equal(first, second);
  gate.resolve();
  assert.equal(await first, 'kept');
  assert.equal(await follow.promise, 'kept');
  assert.deepEqual(seen, ['kept', 'kept']);
});

test('three overlapping calls keep maxActive at 1; the same work unwrapped reaches 2+', async () => {
  let active = 0;
  let maxActive = 0;
  const gate = Promise.withResolvers();
  async function work() {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active -= 1;
  }
  const shared = shareRun(work);
  void shared();
  void shared();
  void shared();
  assert.equal(maxActive, 1);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  active = 0;
  maxActive = 0;
  const bareGate = Promise.withResolvers();
  async function bare() {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await bareGate.promise;
    active -= 1;
  }
  void bare();
  void bare();
  void bare();
  assert.ok(maxActive >= 2);
  bareGate.resolve();
});
