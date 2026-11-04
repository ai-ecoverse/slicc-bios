import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { hold, isHeld } from '../../src/seed/held.js';
import { ordinary, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const chain = (wire, prefix, rootUrl = ordinary) => {
  const ids = Array.from({ length: 12 }, (_, i) => `${prefix}-T${i}`);
  for (let i = 0; i < 12; i++) {
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
  test(`ordering parent depth protected root stays unheld: ${order}`, async (t) => {
    const wire = protocol(t);
    const ids = chain(wire, `own-${order}`, `${protectedOrigin}/root`);
    if (order === 'leaf first') {
      const answer = await attach(wire, ids[11]);
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.equal(isHeld(ids[11]), false);
    } else {
      for (let i = 1; i <= 11; i++) {
        const answer = await attach(wire, ids[i]);
        assert.equal(answer.error, undefined, JSON.stringify(answer));
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
