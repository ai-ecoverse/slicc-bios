import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

test('residual an empty root naming a protected origin cannot become an ordinary attachment', async (t) => {
  const wire = protocol(t);
  wire.target('protected-origin-root');
  wire.hold(
    (message) =>
      message.method === 'Page.getFrameTree' && message.sessionId === 'client-protected-origin-root'
  );
  const attachment = wire.request('Target.attachToTarget', {
    targetId: 'protected-origin-root',
    flatten: true,
  });
  await flush();
  await flush();
  const probe = wire.held.find((message) => message.sessionId === 'client-protected-origin-root');
  assert.ok(probe);
  wire.hold(() => false);
  wire.release(probe, {
    result: {
      frameTree: {
        frame: { id: 'protected-origin-root', url: '', securityOrigin: protectedOrigin },
      },
    },
  });
  const answer = await attachment.answer;
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
  assert.equal(
    wire.sent.filter(
      (message) =>
        message.method === 'Page.getFrameTree' &&
        message.sessionId === 'client-protected-origin-root'
    ).length,
    1
  );
  wire.target('other-origin-root');
  assert.equal(
    (
      await wire.send(
        'Runtime.evaluate',
        { expression: '1' },
        await wire.attach('other-origin-root')
      )
    ).error,
    undefined
  );
});
