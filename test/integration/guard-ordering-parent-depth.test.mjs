import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { hold, isHeld, KEY } from '../../src/seed/held.js';
import { ordinary, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const chain = (wire, prefix, rootUrl = ordinary, length = 12) => {
  const ids = Array.from({ length }, (_, i) => `${prefix}-T${i}`);
  for (let i = 0; i < length; i++) {
    const url = i === 0 ? rootUrl : ordinary;
    const entry = wire.target(ids[i], 'page', {
      id: ids[i],
      url,
      securityOrigin: new URL(url).origin,
      ...(i ? { parentId: ids[i - 1] } : {}),
    });
    Object.assign(entry.info, {
      canAccessOpener: false,
      ...(i ? { parentId: ids[i - 1] } : {}),
    });
  }
  return ids;
};

const attach = (wire, id) => wire.send('Target.attachToTarget', { targetId: id, flatten: true });
const held = (ids) => ids.map((id, i) => (isHeld(id) ? i : null)).filter((i) => i !== null);
const failLookup = (wire, id) => {
  wire.hold((message) => {
    if (message.method !== 'Target.getTargetInfo' || message.params.targetId !== id) return false;
    queueMicrotask(() =>
      wire.release(message, { error: { code: -32000, message: 'No target with given id' } })
    );
    return true;
  });
};

for (const order of ['leaf first', 'ancestors first']) {
  test(`ordering parent depth held root: ${order}`, async (t) => {
    const wire = protocol(t);
    const ids = chain(wire, `held-${order}`);
    hold(ids[0]);
    if (order === 'leaf first') {
      const answer = await attach(wire, ids[11]);
      assert.equal(answer.error?.message, PROTECTED);
      assert.equal(isHeld(ids[11]), true);
    } else {
      for (let i = 1; i <= 11; i++) {
        const answer = await attach(wire, ids[i]);
        assert.equal(answer.error?.message, PROTECTED);
        assert.equal(isHeld(ids[i]), true);
      }
    }
    assert.deepEqual(held(ids), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
}

for (const order of ['leaf first', 'ancestors first']) {
  test(`ordering parent depth protected root refuses its children and stays unheld: ${order}`, async (t) => {
    const wire = protocol(t);
    const ids = chain(wire, `own-${order}`, `${protectedOrigin}/root`);
    if (order === 'leaf first') {
      const answer = await attach(wire, ids[11]);
      assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
      assert.equal(isHeld(ids[11]), false);
    } else {
      for (let i = 1; i <= 11; i++) {
        const answer = await attach(wire, ids[i]);
        assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
        assert.equal(isHeld(ids[i]), false);
      }
    }
    assert.equal(isHeld(ids[0]), false);
    assert.deepEqual(held(ids), []);
  });
}

for (const order of ['leaf first', 'ancestors first']) {
  test(`ordering parent depth ordinary chain stays open: ${order}`, async (t) => {
    const wire = protocol(t);
    const ids = chain(wire, `ordinary-${order}`);
    if (order === 'leaf first') {
      const answer = await attach(wire, ids[11]);
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.equal(isHeld(ids[11]), false);
    } else {
      for (let i = 0; i <= 11; i++) {
        const answer = await attach(wire, ids[i]);
        assert.equal(answer.error, undefined, JSON.stringify(answer));
        assert.equal(isHeld(ids[i]), false);
      }
    }
    assert.deepEqual(held(ids), []);
  });
}

test('ordering parent depth missing parent refuses without a hold', async (t) => {
  const wire = protocol(t);
  const parent = 'depth-missing-parent';
  wire.target(parent, 'page', {
    id: parent,
    url: ordinary,
    securityOrigin: new URL(ordinary).origin,
  });
  const child = wire.target('depth-missing-child', 'page', {
    id: 'depth-missing-child',
    url: ordinary,
    securityOrigin: new URL(ordinary).origin,
    parentId: parent,
  });
  Object.assign(child.info, { canAccessOpener: false, parentId: parent });
  failLookup(wire, parent);
  const answer = await attach(wire, child.info.targetId);
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(isHeld(child.info.targetId), false);
  assert.equal(isHeld(parent), false);
});

test('ordering parent depth cycle refuses without a hold', async (t) => {
  const wire = protocol(t);
  const a = wire.target('depth-cycle-a', 'page', {
    id: 'depth-cycle-a',
    url: ordinary,
    securityOrigin: new URL(ordinary).origin,
    parentId: 'depth-cycle-b',
  });
  const b = wire.target('depth-cycle-b', 'page', {
    id: 'depth-cycle-b',
    url: ordinary,
    securityOrigin: new URL(ordinary).origin,
    parentId: 'depth-cycle-a',
  });
  Object.assign(a.info, { canAccessOpener: false, parentId: 'depth-cycle-b' });
  Object.assign(b.info, { canAccessOpener: false, parentId: 'depth-cycle-a' });
  const answer = await attach(wire, a.info.targetId);
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(isHeld(a.info.targetId), false);
  assert.equal(isHeld(b.info.targetId), false);
});

test('ordering parent depth failing parents do not evict a sign-in hold', async (t) => {
  const memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: (key) => memory.delete(key),
    },
  });
  t.after(() => {
    delete globalThis.localStorage;
  });
  const wire = protocol(t);
  const signIn = 'depth-sign-in-hold';
  const parents = new Set(Array.from({ length: 40 }, (_, i) => `depth-flood-parent-${i}`));
  hold(signIn);
  assert.ok(JSON.parse(globalThis.localStorage.getItem(KEY)).includes(signIn));
  wire.hold((message) => {
    if (message.method !== 'Target.getTargetInfo' || !parents.has(message.params.targetId))
      return false;
    queueMicrotask(() =>
      wire.release(message, { error: { code: -32000, message: 'No target with given id' } })
    );
    return true;
  });
  for (let i = 0; i < 40; i++) {
    const parent = `depth-flood-parent-${i}`;
    const child = `depth-flood-child-${i}`;
    wire.target(parent, 'page', {
      id: parent,
      url: ordinary,
      securityOrigin: new URL(ordinary).origin,
    });
    const entry = wire.target(child, 'page', {
      id: child,
      url: ordinary,
      securityOrigin: new URL(ordinary).origin,
      parentId: parent,
    });
    Object.assign(entry.info, { canAccessOpener: false, parentId: parent });
    const answer = await attach(wire, child);
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(isHeld(child), false);
    assert.equal(isHeld(parent), false);
  }
  assert.ok(JSON.parse(globalThis.localStorage.getItem(KEY)).includes(signIn));
  assert.equal(isHeld(signIn), true);
});

test('ordering parent depth past the bound refuses without a hold', async (t) => {
  const wire = protocol(t);
  const ids = chain(wire, 'depth-bound', ordinary, 66);
  const answer = await attach(wire, ids[65]);
  assert.equal(answer.error?.message, PROTECTED);
  assert.deepEqual(held(ids), []);
});

for (const parent of ['protected', 'protected and opener']) {
  test(`ordering parent depth a lent page under a ${parent} parent keeps its opener hold`, async (t) => {
    const wire = protocol(t);
    const root = `lent-root-${parent}`;
    const child = `lent-child-${parent}`;
    const url = `${protectedOrigin}/root`;
    wire.target(root, 'page', { id: root, url, securityOrigin: protectedOrigin });
    const entry = wire.target(child, 'page', {
      id: child,
      url: `${protectedOrigin}/child`,
      securityOrigin: protectedOrigin,
    });
    Object.assign(entry.info, {
      canAccessOpener: true,
      openerId: root,
      ...(parent === 'protected and opener' ? { parentId: root } : {}),
    });
    const answer = await attach(wire, child);
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(isHeld(child), true);
    assert.equal(isHeld(root), false);
  });
}
