import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { failed, flush, protocol } from './guard-state-fixture.mjs';

const newTab = (id) => ({
  id,
  loaderId: 'newtab-loader',
  url: 'chrome://new-tab-page/',
  securityOrigin: 'chrome://new-tab-page',
});

for (const changed of [false, true]) {
  test(`a previously driven new tab waits for its delayed metadata without trusting stale state: ${changed}`, async (t) => {
    const wire = protocol(t);
    const id = 'delayed-newtab';
    const entry = wire.target(id, 'page', newTab(id));
    await wire.attach(id);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let waiting = true;
    wire.hold(
      (message) =>
        waiting &&
        ((message.method === 'Target.getTargetInfo' && message.params.targetId === id) ||
          (message.method === 'Page.getFrameTree' && message.sessionId === `guard-${id}`))
    );
    const pending = wire.request('Target.attachToTarget', { targetId: id, flatten: true });
    await flush();
    const first = wire.held.find((message) => message.method === 'Target.getTargetInfo');
    assert.ok(first);
    t.mock.timers.tick(1250);
    await flush();
    if (changed) {
      entry.info.url = failed;
      entry.tree.frame = {
        ...entry.tree.frame,
        url: failed,
        securityOrigin: new URL(failed).origin,
      };
    }
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    waiting = false;
    for (const message of wire.held.slice()) {
      if (message === first && changed)
        wire.release(message, {
          result: { targetInfo: { targetId: id, type: 'page', url: 'chrome://new-tab-page/' } },
        });
      else wire.release(message);
    }
    const answer = await pending.answer;
    if (changed) {
      assert.equal(answer.error?.message, PROTECTED);
      assert.equal(answer.result, undefined);
      return;
    }
    assert.equal(answer.error, undefined);
    assert.ok(answer.result.sessionId);
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, answer.result.sessionId)).error,
      undefined
    );
  });
}

test('a driven new tab with no metadata or fallback proof still refuses within the bounded windows', async (t) => {
  const wire = protocol(t);
  const id = 'missing-newtab';
  wire.target(id, 'page', newTab(id));
  await wire.attach(id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.hold(
    (message) =>
      (message.method === 'Target.getTargetInfo' && message.params.targetId === id) ||
      (message.method === 'Page.getFrameTree' && message.sessionId === `guard-${id}`)
  );
  const pending = wire.request('Target.attachToTarget', { targetId: id, flatten: true });
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal((await pending.answer).error?.message, PROTECTED);
  wire.hold(() => false);
  for (const message of wire.held.slice()) wire.release(message);
  await flush();
  assert.equal(wire.delivered.filter((message) => message.id === pending.id).length, 1);
});
