import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

async function placed(t, kind = 'error', distinct = false) {
  const wire = protocol(t);
  const parentId = 'tree-parent';
  const parentRoot = distinct ? 'physical-tree-parent' : parentId;
  const childId = 'tree-child';
  const childRoot = distinct ? 'physical-tree-child' : childId;
  wire.target(parentId, 'page', plainFrame(parentRoot));
  const parentSession = await wire.attach(parentId);
  const frame = errorFrame(childRoot, parentRoot);
  if (kind === 'nonopaque') frame.securityOrigin = 'https://ordinary.invalid';
  if (kind === 'missing-origin') delete frame.securityOrigin;
  if (kind === 'wrong-parent') frame.parentId = 'other-parent-root';
  if (kind === 'live') frame.url = failed;
  const child = wire.target(childId, 'iframe', frame, parentId);
  child.info.url = failed;
  if (kind === 'nested')
    child.tree.childFrames = [{ frame: plainFrame('nested-placement', childRoot) }];
  const childSession = 'tree-placement';
  wire.sessions.set(childSession, childId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: `guard-${parentId}`,
    params: { sessionId: childSession, targetInfo: child.info, waitingForDebugger: false },
  });
  await flush();
  await flush();
  return { wire, parentSession, childSession };
}

for (const distinct of [false, true]) {
  test(`residual an owned opaque iframe error tree preserves only parent runtime namespace ${distinct}`, async (t) => {
    const { wire, parentSession, childSession } = await placed(t, 'error', distinct);
    const mark = wire.sent.length;
    const answer = await wire.send(
      'Runtime.evaluate',
      { expression: 'document.title' },
      parentSession
    );
    assert.equal(answer.error, undefined);
    assert.equal(answer.result?.result?.value, 'synthetic-content');
    assert.equal(
      wire.clients(mark).filter((message) => message.method === 'Runtime.evaluate').length,
      1
    );
    for (const method of [
      'DOM.getDocument',
      'Page.captureScreenshot',
      'Input.dispatchMouseEvent',
    ]) {
      const before = wire.sent.length;
      assert.match(
        (await wire.send(method, { nodeId: 1, type: 'mousePressed', x: 1, y: 1 }, parentSession))
          .error?.message ?? '',
        /^slicc: refused:/
      );
      assert.deepEqual(wire.clients(before), []);
    }
    for (const method of ['Runtime.evaluate', 'DOM.getDocument', 'Page.captureScreenshot']) {
      const before = wire.sent.length;
      assert.match(
        (await wire.send(method, { expression: 'document.title', nodeId: 1 }, childSession)).error
          ?.message ?? '',
        /^slicc: refused:/
      );
      assert.deepEqual(wire.clients(before), []);
    }
  });
}

for (const kind of ['nonopaque', 'missing-origin', 'wrong-parent', 'nested', 'live']) {
  test(`residual ${kind} iframe placement metadata cannot discharge a parent proof`, async (t) => {
    const { wire, parentSession } = await placed(t, kind, true);
    const before = wire.sent.length;
    const answer = await wire.send(
      'Runtime.evaluate',
      { expression: 'document.title' },
      parentSession
    );
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.deepEqual(wire.clients(before), []);
  });
}
