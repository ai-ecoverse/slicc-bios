import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLIGHT_KEY, hold, isHeld, sweep, watchOpened } from '../../src/seed/held.js';
import { flush } from './guard-ordering-fixture.mjs';

const first = 'https://first-idp.invalid/page';
const second = 'https://second-idp.invalid/page';
const other = 'https://other.invalid/page';
function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
function host(infos) {
  let connection;
  const open = async () => {
    connection = {
      close() {},
      send(text) {
        const { id, method } = JSON.parse(text);
        if (method === 'Target.getTargets')
          queueMicrotask(() =>
            connection.onmessage(JSON.stringify({ id, result: { targetInfos: infos() } }))
          );
      },
    };
    return connection;
  };
  return {
    hosts: () => ({ fixture: open }),
    emit: (info) =>
      connection.onmessage(
        JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: info } })
      ),
  };
}

for (const flight of [false, true]) {
  test(`opener watcher full protected-opener sweep, in flight ${flight}`, async () => {
    const store = storage();
    if (flight) store.setItem(FLIGHT_KEY, String(Date.now() + 60000));
    const child = `sweep-cross-${flight}`;
    const wire = host(() => [
      { targetId: `seven-${flight}`, type: 'page', url: 'https://seven.sliccy.ai/page' },
      {
        targetId: child,
        type: 'page',
        url: other,
        openerId: `seven-${flight}`,
        canAccessOpener: false,
      },
    ]);
    await sweep({ hosts: wire.hosts, storage: store });
    assert.equal(isHeld(child, store), flight);
  });
}

for (const order of ['event first', 'poll first']) {
  test(`opener watcher uses a current batch after a held opener moved: ${order}`, async (t) => {
    const store = storage();
    const parent = `watch-parent-${order}`;
    const child = `watch-child-${order}`;
    hold(parent, store);
    let infos = [{ targetId: parent, type: 'page', url: first }];
    const wire = host(() => infos);
    let tick;
    const timers = {
      setInterval(fn) {
        tick = fn;
        return 1;
      },
      clearInterval() {},
    };
    const watcher = watchOpened({ hosts: wire.hosts, storage: store, timers });
    t.after(() => watcher.stop());
    watcher.poke();
    await flush();
    const info = {
      targetId: child,
      type: 'page',
      url: second,
      openerId: parent,
      canAccessOpener: true,
    };
    infos = [{ targetId: parent, type: 'page', url: second }, info];
    if (order === 'event first') wire.emit(info);
    tick();
    await flush();
    if (order === 'poll first') wire.emit(info);
    assert.equal(isHeld(child, store), true);
  });
}

test('opener watcher never exempts a partial event using a prior cross-origin batch', async (t) => {
  const store = storage();
  const parent = 'watch-partial-parent';
  const child = 'watch-partial-child';
  hold(parent, store);
  const info = {
    targetId: child,
    type: 'page',
    url: other,
    openerId: parent,
    canAccessOpener: false,
  };
  const wire = host(() => [{ targetId: parent, type: 'page', url: first }, info]);
  const watcher = watchOpened({
    hosts: wire.hosts,
    storage: store,
    timers: {
      setInterval() {
        return 1;
      },
      clearInterval() {},
    },
  });
  t.after(() => watcher.stop());
  watcher.poke();
  await flush();
  assert.equal(isHeld(child, store), true);
  wire.emit(info);
  assert.equal(isHeld(child, store), true);
});

for (const kind of ['missing URL', 'iframe', 'worker']) {
  test(`opener watcher retains uncertain and parent holds: ${kind}`, async () => {
    const store = storage();
    const parent = `watch-uncertain-${kind}`;
    const child = `watch-uncertain-child-${kind}`;
    hold(parent, store);
    const wire = host(() => [
      { targetId: parent, type: 'page', ...(kind === 'missing URL' ? {} : { url: first }) },
      {
        targetId: child,
        type: kind === 'missing URL' ? 'page' : kind,
        url: other,
        ...(kind === 'missing URL' ? { openerId: parent } : { parentId: parent }),
      },
    ]);
    await sweep({ hosts: wire.hosts, storage: store });
    assert.equal(isHeld(child, store), true);
  });
}

for (const flight of [false, true]) {
  test(`watcher empty noopener metadata is not an inherited document, in flight ${flight}`, async () => {
    const store = storage();
    if (flight) store.setItem(FLIGHT_KEY, String(Date.now() + 60000));
    const parent = `empty-own-parent-${flight}`;
    const child = `empty-own-child-${flight}`;
    let infos = [
      { targetId: parent, type: 'page', url: 'https://seven.sliccy.ai/page' },
      { targetId: child, type: 'page', url: '', openerId: parent, canAccessOpener: false },
    ];
    const wire = host(() => infos);
    await sweep({ hosts: wire.hosts, storage: store });
    assert.equal(isHeld(child, store), flight);
    infos = [infos[0], { ...infos[1], url: other }];
    await sweep({ hosts: wire.hosts, storage: store });
    assert.equal(isHeld(child, store), flight);
  });
}

for (const url of ['about:blank', 'about:srcdoc']) {
  test(`opener watcher remembers an earlier protected opener for a standalone ${url} event`, async (t) => {
    const store = storage();
    const parent = {
      targetId: `retained-watch-parent-${url}`,
      type: 'page',
      url: 'https://seven.sliccy.ai/page',
    };
    const child = {
      targetId: `retained-watch-child-${url}`,
      type: 'page',
      url,
      openerId: parent.targetId,
      canAccessOpener: true,
    };
    let infos = [parent];
    const wire = host(() => infos);
    let tick;
    const watcher = watchOpened({
      hosts: wire.hosts,
      storage: store,
      timers: {
        setInterval(fn) {
          tick = fn;
          return 1;
        },
        clearInterval() {},
      },
    });
    t.after(() => watcher.stop());
    watcher.poke();
    await flush();
    wire.emit(child);
    assert.equal(isHeld(child.targetId, store), true);
    infos = [parent, { ...child, url: other }];
    tick();
    await flush();
    assert.equal(isHeld(child.targetId, store), true);
  });
}

for (const [url, access, flight, expected] of [
  [other, false, false, false],
  [other, false, true, true],
  [other, true, false, true],
  ['about:blank', false, false, true],
  ['about:srcdoc', false, false, true],
]) {
  test(`opener watcher standalone child ${url}, access ${access}, flight ${flight}`, async (t) => {
    const store = storage();
    if (flight) store.setItem(FLIGHT_KEY, String(Date.now() + 60000));
    const prefix = `standalone-noopener-${url}-${access}-${flight}`;
    const parent = {
      targetId: `${prefix}-parent`,
      type: 'page',
      url: 'https://seven.sliccy.ai/page',
    };
    const child = {
      targetId: `${prefix}-child`,
      type: 'page',
      url,
      openerId: parent.targetId,
      canAccessOpener: access,
    };
    let infos = [parent];
    const wire = host(() => infos);
    let tick;
    const watcher = watchOpened({
      hosts: wire.hosts,
      storage: store,
      timers: {
        setInterval(fn) {
          tick = fn;
          return 1;
        },
        clearInterval() {},
      },
    });
    t.after(() => watcher.stop());
    watcher.poke();
    await flush();
    wire.emit(child);
    assert.equal(isHeld(child.targetId, store), expected);
    infos = [parent, { ...child, url: other }];
    tick();
    await flush();
    assert.equal(isHeld(child.targetId, store), expected);
  });
}
