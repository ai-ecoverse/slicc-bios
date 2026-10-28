import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { errorFrame, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

for (const method of [
  'Page.captureScreenshot',
  'DOM.getDocument',
  'Accessibility.getFullAXTree',
  'DOMSnapshot.captureSnapshot',
]) {
  for (const nested of [false, true]) {
    for (const recovery of ['commit', 'remove']) {
      test(`state root replacement retains child ${method} nested ${nested} ${recovery}`, async (t) => {
        const wire = protocol(t);
        const entry = wire.target('swap-owner', 'page', plainFrame('swap-old-root'));
        const session = await wire.attach('swap-owner');
        if (nested) {
          wire.emit({
            method: 'Page.frameAttached',
            sessionId: 'guard-swap-owner',
            params: { frameId: 'swap-middle', parentFrameId: 'swap-old-root' },
          });
          wire.emit({
            method: 'Page.frameNavigated',
            sessionId: 'guard-swap-owner',
            params: { frame: plainFrame('swap-middle', 'swap-old-root') },
          });
        }
        wire.emit({
          method: 'Page.frameNavigated',
          sessionId: 'guard-swap-owner',
          params: {
            frame: errorFrame('swap-unsafe-child', nested ? 'swap-middle' : 'swap-old-root'),
          },
        });
        await flush();
        for (const id of ['swap-new-root', 'swap-final-root']) {
          entry.tree.frame = plainFrame(id);
          wire.emit({
            method: 'Page.frameNavigated',
            sessionId: 'guard-swap-owner',
            params: { frame: entry.tree.frame },
          });
          await flush();
          const mark = wire.sent.length;
          const answer = await wire.send(method, {}, session);
          assert.equal(answer.error?.message, PROTECTED);
          assert.equal(answer.result, undefined);
          assert.deepEqual(wire.clients(mark), []);
          assert.equal((await wire.send('Runtime.evaluate', {}, session)).error, undefined);
        }
        if (recovery === 'commit') {
          wire.emit({
            method: 'Page.frameNavigated',
            sessionId: 'guard-swap-owner',
            params: {
              frame: plainFrame('swap-unsafe-child', nested ? 'swap-middle' : 'swap-final-root'),
            },
          });
        } else {
          wire.emit({
            method: 'Page.frameDetached',
            sessionId: 'guard-swap-owner',
            params: { frameId: 'swap-unsafe-child', reason: 'remove' },
          });
        }
        await flush();
        const mark = wire.sent.length;
        const recovered = await wire.send(method, {}, session);
        assert.equal(recovered.error, undefined);
        assert.ok(recovered.result);
        assert.equal(wire.clients(mark).filter((command) => command.method === method).length, 1);
      });
    }
  }
}
