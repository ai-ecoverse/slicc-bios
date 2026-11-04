import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { hold, isHeld, KEY, sweep } from '../../src/seed/held.js';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const seven = 'https://seven.sliccy.ai/page';
const other = 'https://other.invalid/page';
const page = (wire, id, url, openerId, canAccessOpener = true) => {
  const entry = wire.target(id, 'page', {
    ...plainFrame(id),
    url,
    securityOrigin: URL.parse(url)?.origin ?? '://',
  });
  Object.assign(entry.info, { openerId, canAccessOpener });
  return entry;
};
const attach = (wire, targetId) => wire.send('Target.attachToTarget', { targetId, flatten: true });
const refused = (answer) => {
  assert.equal(answer.error?.message, PROTECTED);
  assert.equal(answer.result, undefined);
};

for (const access of [false, true]) {
  for (const [name, url, admitted] of [
    ['cross origin', other, false],
    ['same origin', ordinary, false],
    ['blank', 'about:blank', false],
    ['srcdoc', 'about:srcdoc', false],
    ['inherited origin', 'blob:https://ordinary.invalid/id', false],
    ['protected child', seven, false],
  ]) {
    test(`opener policy held parent: ${name}, access ${access}`, async (t) => {
      const wire = protocol(t);
      const prefix = `held-${name}-${access}`;
      page(wire, `${prefix}-seven`, seven);
      const parent = page(wire, `${prefix}-parent`, 'about:blank', `${prefix}-seven`);
      refused(await attach(wire, parent.info.targetId));
      parent.info.url = ordinary;
      parent.tree.frame = plainFrame(parent.info.targetId);
      wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: parent.info } });
      await flush();
      refused(await attach(wire, parent.info.targetId));
      const child = page(wire, `${prefix}-child`, url, parent.info.targetId, access);
      wire.emit({ method: 'Target.targetCreated', params: { targetInfo: child.info } });
      await flush();
      const answer = await attach(wire, child.info.targetId);
      if (!admitted) return refused(answer);
      assert.equal(answer.error, undefined, JSON.stringify(answer));
      assert.ok(answer.result.sessionId);
      assert.equal(isHeld(child.info.targetId), false);
    });
  }
}

test('opener policy retains an ordinary inherited tab after its opener closes', async (t) => {
  const wire = protocol(t);
  page(wire, 'retained-seven', seven);
  const child = page(wire, 'retained-child', 'about:srcdoc', 'retained-seven');
  refused(await attach(wire, 'retained-child'));
  wire.emit({ method: 'Target.targetDestroyed', params: { targetId: 'retained-seven' } });
  child.info.url = other;
  delete child.info.openerId;
  child.info.canAccessOpener = false;
  child.tree.frame = {
    ...plainFrame('retained-child'),
    url: other,
    securityOrigin: new URL(other).origin,
  };
  refused(await attach(wire, 'retained-child'));
  assert.equal(isHeld('retained-child'), true);
});

test('opener policy admits a cross-origin page before and after opener closure and another navigation', async (t) => {
  const wire = protocol(t);
  page(wire, 'ordinary-seven', seven);
  const child = page(wire, 'ordinary-child', ordinary, 'ordinary-seven');
  assert.equal((await attach(wire, 'ordinary-child')).error, undefined);
  wire.emit({ method: 'Target.targetDestroyed', params: { targetId: 'ordinary-seven' } });
  delete child.info.openerId;
  child.info.canAccessOpener = false;
  assert.equal((await attach(wire, 'ordinary-child')).error, undefined);
  child.info.url = other;
  child.tree.frame = {
    ...plainFrame('ordinary-child'),
    url: other,
    securityOrigin: new URL(other).origin,
  };
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: child.info } });
  await flush();
  assert.equal((await attach(wire, 'ordinary-child')).error, undefined);
});

for (const reason of ['protected frame', 'protected commit', 'explicit hold', 'protected type']) {
  test(`opener policy retains ${reason} on a cross-origin page after opener closure`, async (t) => {
    const wire = protocol(t);
    const id = `other-reason-${reason}`;
    page(wire, `${id}-seven`, seven);
    const child = page(wire, id, ordinary, `${id}-seven`);
    if (reason === 'explicit hold') hold(id);
    if (reason === 'protected type') child.info.type = 'browser_ui';
    if (reason === 'protected frame')
      child.tree.childFrames = [
        {
          frame: {
            id: `${id}-frame`,
            parentId: id,
            url: seven,
            securityOrigin: new URL(seven).origin,
          },
        },
      ];
    if (reason === 'protected commit') {
      const session = await wire.attach(id);
      child.info.url = seven;
      child.tree.frame = { ...child.tree.frame, url: seven, securityOrigin: new URL(seven).origin };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: child.tree.frame },
      });
      await flush();
      refused(await attach(wire, id));
    }
    if (reason !== 'explicit hold') {
      wire.emit({ method: 'Target.targetDestroyed', params: { targetId: `${id}-seven` } });
      delete child.info.openerId;
      child.info.canAccessOpener = false;
    }
    refused(await attach(wire, id));
  });
}

for (const cross of [false, true]) {
  test(`opener policy owner sweep preserves inherited holds and ordinary children: ${cross}`, async () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    const openerId = `sweep-parent-${cross}`;
    const targetId = `sweep-child-${cross}`;
    const infos = [
      { targetId: openerId, type: 'page', url: ordinary },
      { targetId, type: 'page', url: cross ? other : ordinary, openerId, canAccessOpener: false },
    ];
    hold(openerId, storage);
    const open = async () => {
      const connection = {
        close() {},
        send(text) {
          const { id } = JSON.parse(text);
          queueMicrotask(() =>
            connection.onmessage(JSON.stringify({ id, result: { targetInfos: infos } }))
          );
        },
      };
      return connection;
    };
    await sweep({ hosts: () => ({ test: open }), storage });
    assert.equal(isHeld(targetId, storage), true);
    assert.equal(JSON.parse(storage.getItem(KEY)).includes(targetId), true);
  });
}
