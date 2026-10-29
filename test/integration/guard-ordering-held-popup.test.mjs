import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainFrame, protectedOrigin, protocol } from './guard-state-fixture.mjs';

for (const method of ['Target.getTargets', 'Target.attachToTarget']) {
  test(`residual an unnamed protected popup is not privately driven by ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('held-opener', 'page', {
      ...plainFrame('held-opener'),
      url: `${protectedOrigin}/private`,
      securityOrigin: protectedOrigin,
    });
    const popup = wire.target('held-popup');
    popup.info.url = '';
    popup.info.openerId = 'held-opener';
    popup.info.canAccessOpener = true;
    const answer = await wire.send(
      method,
      method === 'Target.attachToTarget' ? { targetId: 'held-popup', flatten: true } : {}
    );
    if (method === 'Target.attachToTarget') {
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
    } else {
      assert.equal(answer.error, undefined);
      assert.equal(
        answer.result.targetInfos.some((info) => info.targetId === 'held-popup'),
        false
      );
    }
    assert.equal(
      wire.sent.some(
        (message) =>
          message.method === 'Target.attachToTarget' && message.params.targetId === 'held-popup'
      ),
      false,
      'a human-owned popup is classified without arming a private document interceptor'
    );
  });
}
