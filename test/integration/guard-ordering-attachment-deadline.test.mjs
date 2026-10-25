import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const result of ['ordinary', 'malformed', 'expired']) {
  test(`ordering attachment tree deadline ${result}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wire = protocol(t);
    wire.target('cold', 'page', {
      ...plainFrame('cold'),
      url: 'chrome://new-tab-page/',
      securityOrigin: 'chrome://new-tab-page',
    });
    wire.hold(
      (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'client-cold'
    );
    const attach = wire.request('Target.attachToTarget', { targetId: 'cold', flatten: true });
    await flush();
    const tree = wire.held.find((message) => message.method === 'Page.getFrameTree');
    assert.ok(tree);
    t.mock.timers.tick(result === 'expired' ? 10000 : 1100);
    await flush();
    if (result !== 'expired') wire.release(tree, result === 'malformed' ? {} : undefined);
    const answer = await attach.answer;
    if (result === 'ordinary') {
      assert.equal(
        answer.error,
        undefined,
        'a complete cold initial tree stays attachable within the bounded arming deadline'
      );
      assert.equal(answer.result.sessionId, 'client-cold');
    } else {
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
      if (result === 'expired') wire.release(tree);
      await flush();
      assert.equal(
        wire.delivered.some((message) => message.result?.sessionId === 'client-cold'),
        false
      );
    }
  });
}
