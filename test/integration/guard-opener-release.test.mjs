import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { FLIGHT_KEY, hold, isHeld, KEY } from '../../src/seed/held.js';
import { flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const seven = 'https://seven.sliccy.ai/page';
const idp = 'https://idp.invalid/page';
const other = 'https://other.invalid/popup?code=fixture-code';
function storage(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  const store = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  return store;
}
function page(wire, id, url, openerId, canAccessOpener = true) {
  const entry = wire.target(id, 'page', {
    ...plainFrame(id),
    url,
    securityOrigin: URL.parse(url)?.origin ?? '://',
  });
  Object.assign(entry.info, { openerId, canAccessOpener });
  return entry;
}
function move(entry, url) {
  entry.info.url = url;
  entry.tree.frame = { ...entry.tree.frame, url, securityOrigin: URL.parse(url)?.origin ?? '://' };
}
const attach = (wire, targetId) => wire.send('Target.attachToTarget', { targetId, flatten: true });
function denied(answer) {
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(answer.result, undefined);
}
async function heldChild(t, prefix, access) {
  const wire = protocol(t);
  const root = page(wire, `${prefix}-seven`, seven);
  const child = page(wire, `${prefix}-child`, 'about:blank', root.info.targetId, access);
  denied(await attach(wire, child.info.targetId));
  move(child, idp);
  denied(await attach(wire, child.info.targetId));
  return { wire, root, child };
}

for (const [mode, access] of [
  ['production', false],
  ['no-coop', true],
]) {
  for (const link of ['absent', 'stale']) {
    test(`opener release ${mode}: a held ordinary child is admitted after closure, ${link} link`, async (t) => {
      storage(t);
      const { wire, root, child } = await heldChild(t, `release-${mode}-${link}`, access);
      denied(await wire.send('Target.closeTarget', { targetId: root.info.targetId }));
      wire.targets.delete(root.info.targetId);
      wire.emit({ method: 'Target.targetDestroyed', params: { targetId: root.info.targetId } });
      if (link === 'absent') delete child.info.openerId;
      child.info.canAccessOpener = false;
      const answer = await attach(wire, child.info.targetId);
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.ok(answer.result.sessionId);
      assert.equal(isHeld(child.info.targetId), false);
      assert.equal(
        (
          await wire.send(
            'Runtime.evaluate',
            { expression: 'location.href' },
            answer.result.sessionId
          )
        ).error,
        undefined
      );
    });
  }
  test(`opener release ${mode}: in-flight sign-in retains the child after closure`, async (t) => {
    const store = storage(t);
    const { wire, root, child } = await heldChild(t, `flight-${mode}`, access);
    wire.targets.delete(root.info.targetId);
    delete child.info.openerId;
    store.setItem(FLIGHT_KEY, String(Date.now() + 60000));
    denied(await attach(wire, child.info.targetId));
    assert.equal(isHeld(child.info.targetId), true);
    store.setItem(FLIGHT_KEY, '0');
    assert.equal((await attach(wire, child.info.targetId)).error, undefined);
  });
  test(`opener release ${mode}: live held-parent popups remain refused`, async (t) => {
    storage(t);
    const { wire, child: parent } = await heldChild(t, `lineage-${mode}`, access);
    const child = page(wire, `lineage-${mode}-popup`, other, parent.info.targetId, access);
    denied(await attach(wire, child.info.targetId));
    denied(await wire.send('Target.getTargetInfo', { targetId: child.info.targetId }));
    assert.equal(
      wire
        .clients()
        .some(
          (message) =>
            message.method === 'Target.attachToTarget' &&
            message.params.targetId === child.info.targetId
        ),
      false
    );
  });
}

test('opener release follows each direct opener independently through a held chain', async (t) => {
  storage(t);
  const { wire, root, child: parent } = await heldChild(t, 'chain', true);
  const child = page(wire, 'chain-popup', other, parent.info.targetId);
  denied(await attach(wire, child.info.targetId));
  wire.targets.delete(root.info.targetId);
  delete parent.info.openerId;
  assert.equal((await attach(wire, parent.info.targetId)).error, undefined);
  denied(await attach(wire, child.info.targetId));
  wire.targets.delete(parent.info.targetId);
  delete child.info.openerId;
  assert.equal((await attach(wire, child.info.targetId)).error, undefined);
});

test('opener release re-derives a legacy bare-id hold after reload', async (t) => {
  const store = storage(t);
  const wire = protocol(t);
  const entry = page(wire, 'legacy-bare-id', idp);
  store.setItem(KEY, JSON.stringify([entry.info.targetId]));
  assert.equal(isHeld(entry.info.targetId), true);
  assert.equal((await attach(wire, entry.info.targetId)).error, undefined);
  assert.equal(isHeld(entry.info.targetId), false);
  assert.equal(JSON.parse(store.getItem(KEY)).includes(entry.info.targetId), false);
});

for (const url of [
  seven,
  'https://vault.sliccy.ai/page',
  'about:blank',
  'about:srcdoc',
  'data:text/html,x',
]) {
  test(`opener release retains a nonordinary or protected page: ${url}`, async (t) => {
    storage(t);
    const wire = protocol(t);
    const entry = page(wire, `retained-${url}`, url);
    hold(entry.info.targetId);
    denied(await attach(wire, entry.info.targetId));
    assert.equal(isHeld(entry.info.targetId), true);
  });
}

for (const failure of ['empty', 'missing child', 'invalid id', 'error']) {
  test(`opener release requires a positive inventory: ${failure}`, async (t) => {
    storage(t);
    const { wire, root, child } = await heldChild(t, `inventory-${failure}`, true);
    wire.targets.delete(root.info.targetId);
    wire.hold((message) => {
      if (message.method !== 'Target.getTargets') return false;
      const payload =
        failure === 'error'
          ? { error: { message: 'synthetic inventory failure' } }
          : {
              result: {
                targetInfos:
                  failure === 'empty'
                    ? []
                    : failure === 'missing child'
                      ? [{ targetId: 'another-target' }]
                      : [{ targetId: child.info.targetId }, {}],
              },
            };
      queueMicrotask(() => wire.release(message, payload));
      return true;
    });
    denied(await attach(wire, child.info.targetId));
    assert.equal(isHeld(child.info.targetId), true);
  });
}

for (const flushFirst of [false, true]) {
  test(`ordinary noopener initial empty metadata does not create a permanent hold: flush ${flushFirst}`, async (t) => {
    storage(t);
    const wire = protocol(t);
    const root = page(wire, `noopener-root-${flushFirst}`, seven);
    denied(await attach(wire, root.info.targetId));
    assert.equal(isHeld(root.info.targetId), false);
    const child = page(wire, `noopener-child-${flushFirst}`, '', root.info.targetId, false);
    wire.emit({ method: 'Target.targetCreated', params: { targetInfo: child.info } });
    if (flushFirst) {
      await flush();
      denied(await attach(wire, child.info.targetId));
    }
    assert.equal(isHeld(child.info.targetId), false);
    move(child, idp);
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: child.info } });
    await flush();
    const answer = await attach(wire, child.info.targetId);
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, answer.result.sessionId)).error,
      undefined
    );
  });
}

test('an empty page with opener access keeps its hold while the opener is live', async (t) => {
  storage(t);
  const wire = protocol(t);
  const root = page(wire, 'empty-access-root', seven);
  denied(await attach(wire, root.info.targetId));
  const child = page(wire, 'empty-access-child', '', root.info.targetId, true);
  wire.emit({ method: 'Target.targetCreated', params: { targetInfo: child.info } });
  assert.equal(isHeld(child.info.targetId), true);
  move(child, idp);
  await flush();
  denied(await attach(wire, child.info.targetId));
});

for (const change of ['metadata', 'flight']) {
  test(`opener release rejects a ${change} change during its inventory proof`, async (t) => {
    const store = storage(t);
    const { wire, root, child } = await heldChild(t, `mid-proof-${change}`, true);
    wire.targets.delete(root.info.targetId);
    let wait = true;
    wire.hold((message) => wait && message.method === 'Target.getTargets');
    const pending = wire.request('Target.attachToTarget', {
      targetId: child.info.targetId,
      flatten: true,
    });
    await flush();
    assert.ok(wire.held[0]);
    if (change === 'metadata') move(child, 'https://idp.invalid/changed');
    else store.setItem(FLIGHT_KEY, String(Date.now() + 60000));
    wait = false;
    for (const message of wire.held.slice()) wire.release(message);
    denied(await pending.answer);
    assert.equal(isHeld(child.info.targetId), true);
    store.setItem(FLIGHT_KEY, '0');
    assert.equal((await attach(wire, child.info.targetId)).error, undefined);
  });
}

test('opener release does not bypass a protected frame after removing a legacy hold', async (t) => {
  const store = storage(t);
  const wire = protocol(t);
  const child = page(wire, 'legacy-protected-frame', idp);
  child.tree.childFrames = [
    {
      frame: {
        id: 'legacy-protected-subframe',
        parentId: child.info.targetId,
        url: seven,
        securityOrigin: new URL(seven).origin,
      },
    },
  ];
  store.setItem(KEY, JSON.stringify([child.info.targetId]));
  denied(await attach(wire, child.info.targetId));
});

test('opener release retains a legacy hold if its storage update fails', async (t) => {
  const store = storage(t);
  const wire = protocol(t);
  const child = page(wire, 'legacy-storage-failure', idp);
  store.setItem(KEY, JSON.stringify([child.info.targetId]));
  const write = store.setItem;
  store.setItem = () => {
    throw new Error('synthetic storage failure');
  };
  denied(await attach(wire, child.info.targetId));
  assert.equal(isHeld(child.info.targetId), true);
  store.setItem = write;
  assert.equal((await attach(wire, child.info.targetId)).error, undefined);
});
