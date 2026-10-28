import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

test('residual an empty root with opaque null origin waits for an ordinary start document', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('opaque-start');
  entry.info.url = 'http://ordinary.invalid/start';
  entry.tree.frame = {
    ...plainFrame(entry.info.targetId),
    url: entry.info.url,
    securityOrigin: 'http://ordinary.invalid',
  };
  wire.hold(
    (message) =>
      message.method === 'Page.getFrameTree' && message.sessionId === 'client-opaque-start'
  );
  const attachment = wire.request('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  await flush();
  await flush();
  const probe = wire.held.find((message) => message.sessionId === 'client-opaque-start');
  assert.ok(probe);
  wire.hold(() => false);
  wire.release(probe, {
    result: { frameTree: { frame: { id: entry.info.targetId, url: '', securityOrigin: 'null' } } },
  });
  const answer = await attachment.answer;
  assert.equal(answer.error, undefined);
  await wire.send('Page.enable', {}, answer.result.sessionId);
  const tree = await wire.send('Page.getFrameTree', {}, answer.result.sessionId);
  assert.equal(tree.error, undefined);
  assert.equal(tree.result.frameTree.frame.url, entry.info.url);
  assert.equal(
    wire.sent.some((message) =>
      ['Target.detachFromTarget', 'Target.closeTarget'].includes(message.method)
    ),
    false
  );
});

test('residual an empty root that stays opaque never admits a read', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('opaque-unsettled');
  entry.tree.frame = { ...plainFrame(entry.info.targetId), url: '', securityOrigin: 'null' };
  const started = Date.now();
  const answer = await wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
  assert.ok(Date.now() - started < 2500);
  const attempts = wire.sent.filter(
    (message) =>
      message.method === 'Page.getFrameTree' && message.sessionId === 'client-opaque-unsettled'
  ).length;
  assert.ok(attempts >= 1 && attempts <= 25);
  const before = wire.sent.length;
  assert.match(
    (
      await wire.send(
        'Runtime.evaluate',
        { expression: 'document.title' },
        'client-opaque-unsettled'
      )
    ).error?.message ?? '',
    /^slicc: refused:/
  );
  assert.deepEqual(wire.clients(before), []);
});
