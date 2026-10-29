import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const securityOrigin of ['http://ordinary.invalid', new URL(ordinary).origin]) {
  test(`residual an empty root with ordinary origin ${securityOrigin} waits for a complete document`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('ordinary-loading-root');
    wire.hold(
      (message) =>
        message.method === 'Page.getFrameTree' &&
        message.sessionId === 'client-ordinary-loading-root'
    );
    const attachment = wire.request('Target.attachToTarget', {
      targetId: 'ordinary-loading-root',
      flatten: true,
    });
    await flush();
    await flush();
    const probe = wire.held.find((message) => message.sessionId === 'client-ordinary-loading-root');
    assert.ok(probe);
    wire.hold(() => false);
    wire.release(probe, {
      result: {
        frameTree: { frame: { id: 'ordinary-loading-root', url: '', securityOrigin } },
      },
    });
    const answer = await attachment.answer;
    assert.equal(answer.error, undefined);
    assert.equal(answer.result?.sessionId, 'client-ordinary-loading-root');
    assert.equal(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: 'document.title' },
          answer.result.sessionId
        )
      ).error,
      undefined
    );
  });

  test(`residual an empty root that keeps ordinary origin ${securityOrigin} never admits a read`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('ordinary-unsettled-root');
    entry.tree.frame = {
      ...plainFrame('ordinary-unsettled-root'),
      url: '',
      securityOrigin,
    };
    const started = Date.now();
    const answer = await wire.send('Target.attachToTarget', {
      targetId: 'ordinary-unsettled-root',
      flatten: true,
    });
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.ok(Date.now() - started < 2500);
    const attempts = wire.sent.filter(
      (message) =>
        message.method === 'Page.getFrameTree' &&
        message.sessionId === 'client-ordinary-unsettled-root'
    ).length;
    assert.ok(attempts >= 1 && attempts <= 25);
    const before = wire.sent.length;
    assert.match(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: 'document.title' },
          'client-ordinary-unsettled-root'
        )
      ).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.deepEqual(wire.clients(before), []);
  });
}
