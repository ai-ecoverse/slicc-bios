import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from(failed).toString('base64');

for (const recovery of ['remove', 'ordinary-commit']) {
  test(`state linked pending ${recovery}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('parent', 'page', plainFrame('parent-root'));
    wire.target('child', 'iframe', plainFrame('child-root'));
    const parent = await wire.attach('parent');
    await wire.attach('child');
    await wire.send('Page.enable', {}, parent);
    wire.hold((m) => m.id < 2 ** 30 && m.method === 'Page.captureScreenshot');
    const original = wire.request('Page.captureScreenshot', {}, parent);
    await flush();
    const shot = wire.held.find((m) => m.id === original.id);
    assert.ok(shot);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-child',
      params: { frame: errorFrame('child-root') },
    });
    wire.emit({
      method: 'Page.frameAttached',
      sessionId: parent,
      params: { frameId: 'child-root', parentFrameId: 'parent-root' },
    });
    await flush();
    const blocked = await wire.send('Page.captureScreenshot', {}, parent);
    assert.match(
      blocked.error?.message ?? '',
      /^slicc: refused:/,
      'the containing relation is now known and new parent reads are closed'
    );
    if (recovery === 'remove')
      wire.emit({
        method: 'Page.frameDetached',
        sessionId: parent,
        params: { frameId: 'child-root', reason: 'remove' },
      });
    else
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-child',
        params: { frame: plainFrame('child-root') },
      });
    wire.release(shot, { result: { data: opaque } });
    const answer = await original.answer;
    assert.deepEqual(
      {
        refused: /^slicc: refused:/.test(answer.error?.message ?? ''),
        exposed: JSON.stringify(answer).includes(opaque),
      },
      { refused: true, exposed: false },
      'late-known negative scope permanently taints an older parent read'
    );
  });
}
