import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);

for (const reason of ['remove', 'swap', undefined]) {
  test(`ordering loading frame removal ${reason ?? 'unknown'}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('parent');
    const parent = await wire.attach('parent');
    assert.equal((await read(wire, parent)).error, undefined);
    wire.emit({
      method: 'Page.frameAttached',
      sessionId: parent,
      params: { frameId: 'loading-frame', parentFrameId: 'parent' },
    });
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: parent,
      params: { frameId: 'loading-frame', url: ordinary, navigationType: 'differentDocument' },
    });
    wire.emit({
      method: 'Page.frameDetached',
      sessionId: parent,
      params: { frameId: 'loading-frame', ...(reason ? { reason } : {}) },
    });
    await flush();
    const mark = wire.sent.length;
    const answer = await read(wire, parent);
    if (reason === 'remove') {
      assert.equal(
        answer.error,
        undefined,
        'authoritative removal permits fresh parent confirmation'
      );
      assert.equal(answer.result?.result?.value, 'synthetic-content');
    } else {
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
      assert.deepEqual(
        wire.clients(mark),
        [],
        'a swap or unknown removal does not reopen the frame'
      );
    }
  });
}

test('ordering attached frame removal', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('parent');
  const parent = await wire.attach('parent');
  const frame = plainFrame('child', 'parent');
  wire.target('child', 'iframe', frame, 'parent');
  entry.tree.childFrames = [{ frame }];
  const child = wire.attached('child', parent);
  await flush();
  assert.equal((await read(wire, parent)).error, undefined);
  delete entry.tree.childFrames;
  wire.emit({
    method: 'Page.frameDetached',
    sessionId: parent,
    params: { frameId: 'child', reason: 'remove' },
  });
  wire.emit({
    method: 'Target.detachedFromTarget',
    sessionId: parent,
    params: { sessionId: child, targetId: 'child' },
  });
  wire.emit({
    method: 'Target.detachedFromTarget',
    params: { sessionId: 'guard-child', targetId: 'child' },
  });
  await flush();
  const recovered = await read(wire, parent);
  assert.equal(
    recovered.error,
    undefined,
    'a failed retired child does not poison the surviving parent'
  );
  assert.equal(recovered.result?.result?.value, 'synthetic-content');
});
