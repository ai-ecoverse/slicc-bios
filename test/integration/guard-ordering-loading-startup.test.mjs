import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-ordering-fixture.mjs';

async function firstTree(t, id, tree) {
  const wire = protocol(t);
  const entry = wire.target(id);
  wire.hold(
    (message) => message.method === 'Page.getFrameTree' && message.sessionId === `client-${id}`
  );
  const attachment = wire.request('Target.attachToTarget', { targetId: id, flatten: true });
  await flush();
  await flush();
  const pending = wire.held.find((message) => message.sessionId === `client-${id}`);
  assert.ok(pending, 'the caller attachment reaches an independent frame-tree check');
  entry.tree = tree;
  wire.hold(() => false);
  wire.release(pending);
  return { wire, entry, attachment };
}

test('residual an initial about blank with empty origin waits for an ordinary document', {
  timeout: 5000,
}, async (t) => {
  const id = 'startup-about-empty';
  const started = Date.now();
  const { wire, entry, attachment } = await firstTree(t, id, {
    frame: { id, url: 'about:blank', securityOrigin: '', loaderId: 'initial-about' },
  });
  const timer = setTimeout(() => {
    entry.tree = { frame: { ...plainFrame(id), loaderId: 'ordinary-startup' } };
  }, 200);
  t.after(() => clearTimeout(timer));
  const answer = await attachment.answer;
  assert.equal(answer.error, undefined);
  assert.ok(Date.now() - started >= 200);
  const session = answer.result.sessionId;
  const tree = await wire.send('Page.getFrameTree', {}, session);
  assert.equal(tree.error, undefined);
  assert.equal(tree.result.frameTree.frame.url, ordinary);
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
    undefined
  );
  assert.equal(
    wire.sent.some((message) => message.method === 'Target.detachFromTarget'),
    false
  );
});

for (const state of ['never settled', 'protected origin', 'child about blank']) {
  test(`residual initial about blank remains closed for ${state}`, { timeout: 5000 }, async (t) => {
    const id = `startup-closed-${state}`;
    const initial = {
      id,
      url: 'about:blank',
      securityOrigin: state === 'protected origin' ? protectedOrigin : '',
      loaderId: 'unsettled-about',
    };
    const tree =
      state === 'child about blank'
        ? {
            frame: { ...plainFrame(id), loaderId: 'ordinary-parent' },
            childFrames: [{ frame: { ...initial, id: `${id}-child`, parentId: id } }],
          }
        : { frame: initial };
    const started = Date.now();
    const { wire, attachment } = await firstTree(t, id, tree);
    const answer = await attachment.answer;
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.ok(Date.now() - started < 2000);
    const attempts = wire.sent.filter(
      (message) => message.method === 'Page.getFrameTree' && message.sessionId === `client-${id}`
    ).length;
    assert.ok(attempts >= 1 && attempts <= (state === 'never settled' ? 25 : 1));
    const sent = wire.sent.length;
    assert.match(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, `client-${id}`)).error
        ?.message ?? '',
      /^slicc: refused:/
    );
    assert.deepEqual(wire.clients(sent), []);
  });
}
