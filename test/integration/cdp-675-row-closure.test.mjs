import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { awaitRowClosure, ownedRowPids } from './cdp-675-row-closure.mjs';

test('row teardown accepts only exact server and matching spawned holder PIDs', () => {
  assert.deepEqual(
    ownedRowPids('target', '77\n', 'holder-pid 88 tab target\nholder-pid 99 tab unrelated'),
    [77, 88]
  );
  assert.deepEqual(ownedRowPids('target', '77', 'no holder was spawned'), [77]);
  for (const pid of ['invalid', '1', '-9', '1.5'])
    assert.throws(() => ownedRowPids('target', pid, ''));
  assert.throws(() =>
    ownedRowPids('target', '77', 'holder-pid 88 tab target\nholder-pid 89 tab target')
  );
  assert.throws(() => ownedRowPids('target', '77', 'holder-pid 77 tab target'));
});

test('next protected seed waits for actual guard closure and both owned processes within one bound', async (t) => {
  const previous = { name: 'previous', ownedPids: [77, 88], guardConnections: [1, 2] };
  const saved = { connections: globalThis.cdp675Connections, client: globalThis.cdp675Client };
  t.after(() => {
    globalThis.cdp675Connections = saved.connections;
    globalThis.cdp675Client = saved.client;
  });
  globalThis.cdp675Connections = new Map([
    [1, {}],
    [2, {}],
  ]);
  const probes = [];
  let status = 1;
  globalThis.cdp675Client = {
    async run(argv, options) {
      probes.push({ argv, options });
      return { status };
    },
  };
  const page = {
    async within(bound, predicate, args) {
      assert.equal(bound, 5000);
      assert.equal(await predicate(args), false);
      globalThis.cdp675Connections.get(1).closed = true;
      assert.equal(await predicate(args), false);
      assert.equal(probes.length, 0);
      globalThis.cdp675Connections.get(2).closed = true;
      assert.equal(await predicate(args), false);
      status = 0;
      assert.equal(await predicate(args), true);
    },
  };
  const result = await awaitRowClosure(page, previous);
  assert.equal(result.previousRow, 'previous');
  assert.equal(result.boundMs, 5000);
  assert.ok(result.completedAt);
  assert.deepEqual(probes[0], {
    argv: ['bash', '-c', 'test ! -e /proc/77/stat && test ! -e /proc/88/stat'],
    options: { cwd: '/' },
  });
  await assert.rejects(
    awaitRowClosure(
      {
        within() {
          throw new Error('closure bound expired');
        },
      },
      previous
    ),
    /bound expired/
  );
  for (const row of [
    null,
    {},
    { ownedPids: [] },
    { ownedPids: [77] },
    { ownedPids: [1], guardConnections: [1] },
    { ownedPids: [77], guardConnections: [-1] },
  ])
    await assert.rejects(awaitRowClosure(page, row));
});

test('test-only transport lifetime tap observes extension closed state without requiring an onclose callback', () => {
  const source = readFileSync(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function cdp675Tap(connection, boundary, route)');
  const end = source.indexOf('\n`\n  );', start);
  const context = vm.createContext({ Date, Map, JSON });
  const tap = vm.runInContext(source.slice(start, end) + '; cdp675Tap', context);
  let closed = false;
  const raw = {
    get cdp675Closed() {
      return closed;
    },
    send() {},
    close() {
      closed = true;
    },
  };
  const route = tap(raw, 'route', { kind: 'extension' });
  const bios = tap(
    {
      get cdp675Closed() {
        return route.cdp675Closed;
      },
      send() {},
      close() {
        route.close();
      },
    },
    'bios',
    { kind: 'extension' }
  );
  assert.equal(context.cdp675Connections.get(1).closed, false);
  assert.equal(context.cdp675Connections.get(2).closed, false);
  bios.close();
  assert.equal(context.cdp675Connections.get(1).closed, true);
  assert.equal(context.cdp675Connections.get(2).closed, true);
  assert.equal(context.cdp675Connections.get(1).closedAt, undefined);
  assert.equal(context.cdp675Connections.get(2).closedAt, undefined);
});

test('test-only transport lifetime tap preserves callbacks and records actual route and bios closure', () => {
  const source = readFileSync(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function cdp675Tap(connection, boundary, route)');
  const end = source.indexOf('\n`\n  );', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ Date, Map, JSON });
  const tap = vm.runInContext(source.slice(start, end) + '; cdp675Tap', context);
  const raw = {
    send() {},
    close() {
      this.onclose('closed');
    },
  };
  const wrapper = tap(raw, 'route', { kind: 'link' });
  const seen = [];
  wrapper.onclose = (value) => seen.push(value);
  assert.equal(context.cdp675Connections.get(1).closedAt, undefined);
  wrapper.close();
  assert.deepEqual(seen, ['closed']);
  assert.ok(context.cdp675Connections.get(1).closedAt);
  assert.ok(source.includes('awaitRowClosure(page, trace.rows.at(-2))'));
  assert.match(source, /if \(scene\.bfcache && !scene\.ordinaryBfcache\)/);
  assert.ok(
    source.indexOf('row.previousRowClosure =') <
      source.indexOf(
        "chrome.cdp.send('Target.createTarget'",
        source.indexOf('row.previousRowClosure =')
      )
  );
});
