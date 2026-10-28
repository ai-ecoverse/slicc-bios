import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { failed, flush, ordinary, protocol } from './guard-state-fixture.mjs';

for (const exit of ['Page.navigate', 'Page.reload', 'Page.stopLoading', 'Target.closeTarget']) {
  test(`a refused second attachment preserves the first session's pending-load exit ${exit}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('existing-exit');
    const first = await wire.attach('existing-exit');
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: 'guard-existing-exit',
      params: {
        frameId: 'existing-exit',
        url: failed,
        loaderId: 'existing-pending-loader',
        navigationType: 'differentDocument',
      },
    });
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: 'guard-existing-exit',
      params: {
        requestId: 'existing-pending-loader',
        loaderId: 'existing-pending-loader',
        frameId: 'existing-exit',
        type: 'Document',
        request: { url: failed },
      },
    });
    const second = 'separate-refused-client';
    const received = wire.delivered.length;
    wire.emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: second, targetInfo: entry.info, waitingForDebugger: true },
    });
    await flush();
    assert.equal(
      wire.delivered
        .slice(received)
        .some(
          (message) =>
            message.method === 'Target.attachedToTarget' && message.params.sessionId === second
        ),
      false
    );
    assert.equal((await wire.send('Runtime.evaluate', {}, second)).error?.message, PROTECTED);
    assert.equal((await wire.send('Runtime.evaluate', {}, first)).error?.message, PROTECTED);
    const browser = exit.startsWith('Target.');
    const answer = await wire.send(
      exit,
      browser ? { targetId: 'existing-exit' } : exit === 'Page.navigate' ? { url: ordinary } : {},
      browser ? undefined : first
    );
    assert.equal(answer.error, undefined);
    if (!browser) {
      wire.emit({
        method: 'Network.loadingFailed',
        sessionId: 'guard-existing-exit',
        params: {
          requestId: 'existing-pending-loader',
          type: 'Document',
          errorText: 'net::ERR_ABORTED',
        },
      });
      await flush();
      assert.equal((await wire.send('Runtime.evaluate', {}, first)).error, undefined);
      assert.equal((await wire.send('Runtime.evaluate', {}, second)).error?.message, PROTECTED);
    }
  });
}
