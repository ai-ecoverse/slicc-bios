import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const stage of [
  'private-metadata',
  'incomplete-first',
  'permanent-incomplete',
  'protected-after-incomplete',
  'shared-expiry',
]) {
  test(`ordering complete initial classification ${stage}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const wire = protocol(t);
    const entry = wire.target('cold', 'page', {
      ...plainFrame('cold'),
      url: 'chrome://new-tab-page/',
      securityOrigin: 'chrome://new-tab-page',
    });
    let first = true;
    wire.hold((message) => {
      if (message.method !== 'Page.getFrameTree') return false;
      if (stage === 'private-metadata') return message.sessionId === 'guard-cold';
      if (stage === 'shared-expiry') return true;
      if (message.sessionId !== 'client-cold' || !first) return false;
      first = false;
      return true;
    });
    const attach = wire.request('Target.attachToTarget', { targetId: 'cold', flatten: true });
    await flush();
    const read = wire.held.find((message) => message.method === 'Page.getFrameTree');
    assert.ok(read);
    if (stage === 'private-metadata') {
      t.mock.timers.tick(1100);
      wire.release(read);
    } else if (stage === 'shared-expiry') {
      t.mock.timers.tick(9000);
      wire.release(read);
      await flush();
      const second = wire.held.find((message) => message.method === 'Page.getFrameTree');
      assert.ok(second);
      t.mock.timers.tick(1100);
      await flush();
      wire.release(second);
    } else {
      if (stage === 'permanent-incomplete')
        entry.tree = { frame: { id: 'cold', url: '', securityOrigin: '://' } };
      if (stage === 'protected-after-incomplete')
        entry.tree = { frame: { ...plainFrame('cold'), url: failed } };
      wire.release(read, {
        result: { frameTree: { frame: { id: 'cold', url: '', securityOrigin: '://' } } },
      });
      if (stage === 'incomplete-first')
        wire.emit({
          method: 'Page.frameNavigated',
          sessionId: 'guard-cold',
          params: { frame: entry.tree.frame },
        });
    }
    const answer = await attach.answer;
    if (['private-metadata', 'incomplete-first'].includes(stage))
      assert.equal(answer.error, undefined);
    else {
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
    }
    if (stage === 'permanent-incomplete')
      assert.equal(
        wire.sent.filter(
          (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'client-cold'
        ).length,
        3,
        'initial completeness retries are finite and never accept an empty snapshot'
      );
  });
}
