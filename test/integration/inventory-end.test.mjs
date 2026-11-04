import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { followInventory, REPEAT_MS, THROTTLE_MS } from '../../src/seed/inventory.js';
import { createRemote } from '../../src/seed/remote.js';

function harness({ hold = false, extra = false } = {}) {
  let clock = 0;
  const scheduled = new Map();
  const end = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const written = Promise.withResolvers();
  const changed = Promise.withResolvers();
  const log = [];
  const first = { seq: 1 };
  const latest = { seq: 2 };
  const events = (async function* () {
    yield latest;
    if (extra) {
      await changed.promise;
      yield { seq: 3 };
    }
    await end.promise;
  })();
  const timers = {
    set(fn, ms) {
      const id = Symbol();
      scheduled.set(id, { fn, at: clock + ms });
      return id;
    },
    clear(id) {
      scheduled.delete(id);
    },
  };
  const stream = {
    read: () => disconnected.promise,
    settled: Promise.resolve(true),
    async write(snapshot) {
      log.push(['write', snapshot]);
      if (hold) await written.promise;
      log.push(['written', snapshot.seq]);
    },
    closeWrite() {
      log.push(['close']);
    },
  };
  const done = followInventory(stream, first, events, {
    render: async (snapshot) => snapshot,
    line: (snapshot) => snapshot,
    now: () => clock,
    timers,
  });
  return {
    done,
    end: end.resolve,
    disconnect: () => disconnected.resolve(null),
    release: written.resolve,
    change: changed.resolve,
    log,
    scheduled,
    advance(ms) {
      clock += ms;
      for (const [id, timer] of scheduled) {
        if (timer.at > clock) continue;
        scheduled.delete(id);
        timer.fn();
      }
    },
  };
}

test('remote inventory watch writes the shaped final snapshot line before EOF', {
  timeout: 2000,
}, async () => {
  const end = Promise.withResolvers();
  const read = Promise.withResolvers();
  const written = Promise.withResolvers();
  const scheduled = new Map();
  const log = [];
  const agent = { id: 'agent', status: 'idle', kind: 'cone', queued: 0, since: 5 };
  const snapshot = { seq: 1, changedAt: 5, agents: [agent] };
  const events = (async function* () {
    yield { seq: 2, changedAt: 10, agents: [{ ...agent, status: 'running' }] };
    await end.promise;
  })();
  const remote = createRemote({
    control: async () => ({
      async inventory(options) {
        assert.deepEqual(options, { watch: true });
        return { snapshot, events };
      },
    }),
    inventory: async () => ({
      instance: { id: 'instance', name: 'seven' },
      hash: async () => 'opaque',
    }),
    now: () => 1000,
    timers: {
      set(fn, ms) {
        const id = Symbol();
        scheduled.set(id, { fn, ms });
        return id;
      },
      clear(id) {
        scheduled.delete(id);
      },
    },
  });
  const done = remote.handle(
    { key: 'link' },
    { op: 'inventory', watch: true },
    {
      accepted: (value) => log.push(['accepted', value]),
      read: () => read.promise,
      settled: Promise.resolve(true),
      async write(bytes) {
        assert.ok(bytes instanceof Uint8Array);
        const text = new TextDecoder().decode(bytes);
        assert.ok(text.endsWith('\n'));
        log.push(['line', JSON.parse(text)]);
        await written.promise;
        log.push(['written']);
      },
      closeWrite: () => log.push(['close']),
      reset: (reason) => log.push(['reset', reason]),
    }
  );
  await setImmediate();
  assert.deepEqual(
    [...scheduled.values()].map(({ ms }) => ms),
    [REPEAT_MS, THROTTLE_MS]
  );
  assert.equal(log.length, 1);
  assert.equal(log[0][0], 'accepted');
  assert.equal(log[0][1].seq, 1);
  end.resolve();
  await setImmediate();
  assert.deepEqual(log.slice(1), [
    [
      'line',
      {
        t: 'inventory',
        v: 1,
        instance: { id: 'instance', name: 'seven' },
        seq: 2,
        changedAt: 10,
        reportedAt: 1000,
        counts: { running: 1, queued: 0, waiting: 0, error: 0, idle: 0 },
        agents: [{ id: 'opaque', kind: 'cone', status: 'running', queued: 0, since: 5 }],
      },
    ],
  ]);
  written.resolve();
  await done;
  assert.deepEqual(log.slice(2), [['written'], ['close']]);
  assert.equal(scheduled.size, 0);
  read.resolve(null);
});

test('inventory sends a throttled final change and waits for its write before closing', {
  timeout: 2000,
}, async () => {
  const run = harness({ hold: true });
  await setImmediate();
  assert.deepEqual(
    [...run.scheduled.values()].map(({ at }) => at),
    [REPEAT_MS, THROTTLE_MS]
  );
  assert.deepEqual(run.log, []);
  run.end();
  await setImmediate();
  assert.deepEqual(run.log, [['write', { t: 'inventory', seq: 2 }]]);
  run.release();
  await run.done;
  assert.deepEqual(run.log, [['write', { t: 'inventory', seq: 2 }], ['written', 2], ['close']]);
  assert.equal(run.scheduled.size, 0);
});

test('inventory drops the pending final change when the stream is gone', {
  timeout: 2000,
}, async () => {
  const run = harness();
  await setImmediate();
  run.disconnect();
  await setImmediate();
  run.end();
  await run.done;
  assert.deepEqual(run.log, []);
  assert.equal(run.scheduled.size, 0);
});

test('inventory does not resend the latest snapshot when it was already sent', {
  timeout: 2000,
}, async () => {
  const run = harness();
  await setImmediate();
  run.advance(THROTTLE_MS);
  await setImmediate();
  run.end();
  await run.done;
  assert.deepEqual(run.log, [['write', { t: 'inventory', seq: 2 }], ['written', 2], ['close']]);
  assert.equal(run.scheduled.size, 0);
});

test('inventory waits for an already pending write without sending it twice', {
  timeout: 2000,
}, async () => {
  const run = harness({ hold: true });
  await setImmediate();
  run.advance(THROTTLE_MS);
  await setImmediate();
  run.end();
  await setImmediate();
  assert.deepEqual(run.log, [['write', { t: 'inventory', seq: 2 }]]);
  run.release();
  await run.done;
  assert.deepEqual(run.log, [['write', { t: 'inventory', seq: 2 }], ['written', 2], ['close']]);
});

test('inventory drains an earlier write and sends the final change once', {
  timeout: 2000,
}, async () => {
  const run = harness({ hold: true, extra: true });
  await setImmediate();
  run.advance(THROTTLE_MS);
  await setImmediate();
  run.change();
  await setImmediate();
  run.end();
  await setImmediate();
  assert.deepEqual(run.log, [['write', { t: 'inventory', seq: 2 }]]);
  run.release();
  await run.done;
  assert.deepEqual(run.log, [
    ['write', { t: 'inventory', seq: 2 }],
    ['written', 2],
    ['write', { t: 'inventory', seq: 3 }],
    ['written', 3],
    ['close'],
  ]);
  assert.equal(run.scheduled.size, 0);
});

test('inventory stops draining if the stream goes away during the final write', {
  timeout: 2000,
}, async () => {
  const run = harness({ hold: true });
  await setImmediate();
  run.end();
  await setImmediate();
  run.disconnect();
  await setImmediate();
  run.release();
  await run.done;
  assert.deepEqual(run.log, [
    ['write', { t: 'inventory', seq: 2 }],
    ['written', 2],
  ]);
  assert.equal(run.scheduled.size, 0);
});
