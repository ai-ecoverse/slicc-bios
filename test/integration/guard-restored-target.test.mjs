import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

for (const kind of ['ordinary', 'error']) {
  test(`restored target a protected target hint cuts the ${kind} session and keeps content closed`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('target-hint');
    const session = await wire.attach('target-hint');
    await wire.send('Page.enable', {}, session);
    if (kind === 'error') {
      entry.tree.frame = errorFrame('target-hint');
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: entry.tree.frame },
      });
      await flush();
    }
    entry.info.url = `${protectedOrigin}/private`;
    entry.history = { currentIndex: 0, entries: [{ id: 1, url: ordinary }] };
    const mark = wire.sent.length;
    const messages = wire.delivered.length;
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    assert.equal(
      wire.sent
        .slice(mark)
        .some(
          (message) =>
            message.method === 'Target.detachFromTarget' && message.params.sessionId === session
        ),
      true
    );
    assert.equal(
      JSON.stringify(wire.delivered.slice(messages)).includes(`${protectedOrigin}/private`),
      false
    );
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error
        ?.message,
      PROTECTED
    );
    assert.equal(
      (await wire.send('Page.captureScreenshot', {}, session)).error?.message,
      PROTECTED
    );
    entry.info.url = BLANKED;
    entry.tree.frame = { id: 'target-hint', url: BLANKED, securityOrigin: '://' };
    entry.history = {
      currentIndex: 0,
      entries: [{ id: 1, url: BLANKED, userTypedURL: `${protectedOrigin}/private` }],
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    await flush();
    wire.emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: session, targetId: 'target-hint' },
    });
    await flush();
    const shot = await wire.send('Page.captureScreenshot', {}, session);
    assert.equal(shot.error?.message, PROTECTED);
  });
}

test('restored target a protected frame discovered at the target event still detaches', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('live-target');
  const session = await wire.attach('live-target');
  entry.info.url = `${protectedOrigin}/private`;
  entry.tree.frame = {
    ...plainFrame('live-target'),
    url: entry.info.url,
    securityOrigin: protectedOrigin,
  };
  const mark = wire.sent.length;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  assert.equal(
    wire.sent
      .slice(mark)
      .some(
        (message) =>
          message.method === 'Target.detachFromTarget' && message.params.sessionId === session
      ),
    true
  );
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error?.message,
    PROTECTED
  );
});
