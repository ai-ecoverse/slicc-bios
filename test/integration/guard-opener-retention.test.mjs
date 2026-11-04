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
  for (const state of ['missing attribution', 'closed opener', 'stale opener id', 'no flight']) {
    test(`opener retention ${mode}: ${state} does not release a hold`, async (t) => {
      const store = storage(t);
      const { wire, root, child } = await heldChild(t, `retain-${mode}-${state}`, access);
      if (state === 'closed opener' || state === 'stale opener id') {
        wire.targets.delete(root.info.targetId);
        wire.emit({ method: 'Target.targetDestroyed', params: { targetId: root.info.targetId } });
      }
      if (state !== 'stale opener id') delete child.info.openerId;
      child.info.canAccessOpener = false;
      assert.equal(store.getItem(FLIGHT_KEY), null);
      await flush();
      denied(await attach(wire, child.info.targetId));
      denied(await wire.send('Target.getTargetInfo', { targetId: child.info.targetId }));
      assert.equal(isHeld(child.info.targetId), true);
      assert.equal(JSON.parse(store.getItem(KEY)).includes(child.info.targetId), true);
      if (state === 'missing attribution' || state === 'no flight')
        assert.equal(wire.targets.has(root.info.targetId), true);
    });
  }
  test(`opener retention ${mode}: live held-parent popups remain refused`, async (t) => {
    storage(t);
    const { wire, child: parent } = await heldChild(t, `retained-lineage-${mode}`, access);
    const child = page(wire, `retained-lineage-${mode}-popup`, other, parent.info.targetId, access);
    denied(await attach(wire, child.info.targetId));
    denied(await wire.send('Target.getTargetInfo', { targetId: child.info.targetId }));
  });
}

test('opener retention keeps legacy bare ids after a reload without flight or opener metadata', async (t) => {
  const store = storage(t);
  const wire = protocol(t);
  const entry = page(wire, 'retained-legacy-bare-id', idp);
  entry.info.canAccessOpener = false;
  store.setItem(KEY, JSON.stringify([entry.info.targetId]));
  assert.equal(store.getItem(FLIGHT_KEY), null);
  denied(await attach(wire, entry.info.targetId));
  assert.equal(isHeld(entry.info.targetId), true);
  assert.equal(JSON.parse(store.getItem(KEY)).includes(entry.info.targetId), true);
});

test('opener retention keeps the entire chain after each direct opener closes', async (t) => {
  storage(t);
  const { wire, root, child: parent } = await heldChild(t, 'retained-chain', true);
  const child = page(wire, 'retained-chain-popup', other, parent.info.targetId);
  denied(await attach(wire, child.info.targetId));
  wire.targets.delete(root.info.targetId);
  delete parent.info.openerId;
  denied(await attach(wire, parent.info.targetId));
  denied(await attach(wire, child.info.targetId));
  wire.targets.delete(parent.info.targetId);
  delete child.info.openerId;
  denied(await attach(wire, child.info.targetId));
});

for (const url of [
  seven,
  'https://vault.sliccy.ai/page',
  'about:blank',
  'about:srcdoc',
  'data:text/html,x',
]) {
  test(`opener retention keeps a nonordinary or protected page: ${url}`, async (t) => {
    storage(t);
    const wire = protocol(t);
    const entry = page(wire, `retained-own-${url}`, url);
    hold(entry.info.targetId);
    denied(await attach(wire, entry.info.targetId));
    assert.equal(isHeld(entry.info.targetId), true);
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
