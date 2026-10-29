import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const method of ['Runtime.evaluate', 'Page.captureScreenshot', 'DOM.getOuterHTML']) {
  test(method === 'Runtime.evaluate'
    ? 'residual a stale child tree preserves the ordinary parent Runtime.evaluate'
    : `residual a stale tree after an error commit cannot reopen ${method}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('stale-owner');
    const oldChild = { ...plainFrame('stale-child', 'stale-owner'), loaderId: 'old-loader' };
    entry.tree.childFrames = [{ frame: oldChild }];
    const session = await wire.attach('stale-owner');
    const second = 'second-stale-owner';
    wire.sessions.set(second, 'stale-owner');
    wire.hold((message) => message.method === 'Page.getFrameTree' && message.sessionId === second);
    wire.emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: second, targetInfo: entry.info, waitingForDebugger: false },
    });
    await flush();
    const tree = wire.held.find((message) => message.sessionId === second);
    assert.ok(tree, 'the ordinary tree was requested before the error committed');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: {
        frame: { ...errorFrame('stale-child', 'stale-owner'), loaderId: 'error-loader' },
      },
    });
    await flush();
    wire.hold(() => false);
    wire.release(tree, { result: { frameTree: entry.tree } });
    await flush();
    await flush();
    const mark = wire.sent.length;
    const answer = await wire.send(
      method,
      method === 'Runtime.evaluate' ? { expression: 'document.title' } : { nodeId: 1 },
      session
    );
    if (method === 'Runtime.evaluate') {
      assert.equal(answer.error, undefined);
      assert.equal(wire.clients(mark).filter((message) => message.method === method).length, 1);
    } else {
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
      assert.deepEqual(wire.clients(mark), [], 'an older tree cannot reopen the child’s content');
    }
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-stale-owner',
      params: { frame: { ...plainFrame('stale-child', 'stale-owner'), loaderId: 'fresh-loader' } },
    });
    entry.tree.childFrames = [
      { frame: { ...plainFrame('stale-child', 'stale-owner'), loaderId: 'fresh-loader' } },
    ];
    assert.equal(
      (await wire.send(method, { expression: '1', nodeId: 1 }, session)).error,
      undefined
    );
  });
}

for (const method of ['Runtime.evaluate', 'Page.captureScreenshot', 'DOM.getOuterHTML']) {
  test(`residual a client-only ordinary receipt cannot clear protected error state ${method}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('receipt-owner');
    const session = await wire.attach('receipt-owner');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-receipt-owner',
      params: { frame: { ...errorFrame('receipt-owner'), loaderId: 'failed-receipt-loader' } },
    });
    await flush();
    entry.tree.frame = { ...plainFrame('receipt-owner'), loaderId: 'ordinary-receipt-loader' };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    await flush();
    const mark = wire.sent.length;
    const answer = await wire.send(method, { expression: '1', nodeId: 1 }, session);
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.deepEqual(wire.clients(mark), []);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-receipt-owner',
      params: { frame: entry.tree.frame },
    });
    await flush();
    assert.equal(
      (await wire.send(method, { expression: '1', nodeId: 1 }, session)).error,
      undefined
    );
  });
}

test('residual an error iframe target preserves only its ordinary parent runtime', async (t) => {
  const wire = protocol(t);
  const parent = wire.target('parent-target', 'page', plainFrame('parent-root'));
  const parentSession = await wire.attach('parent-target');
  const child = wire.target(
    'child-target',
    'iframe',
    plainFrame('child-root', 'parent-root'),
    'parent-target'
  );
  parent.tree.childFrames = [{ frame: child.tree.frame }];
  const childSession = wire.attached('child-target', parentSession);
  await flush();
  await flush();
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '1' }, childSession)).error,
    undefined
  );
  const oldChild = child.tree.frame;
  child.tree.frame = {
    ...errorFrame('child-root', 'parent-root'),
    loaderId: 'error-iframe-loader',
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-child-target',
    params: { frame: child.tree.frame },
  });
  await flush();
  child.tree.frame = oldChild;
  wire.sessions.set('second-parent-session', 'parent-target');
  wire.emit({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 'second-parent-session',
      targetInfo: parent.info,
      waitingForDebugger: false,
    },
  });
  await flush();
  await flush();
  const mark = wire.sent.length;
  const root = await wire.send('Runtime.evaluate', { expression: 'document.title' }, parentSession);
  assert.equal(root.error, undefined);
  assert.equal(
    wire.clients(mark).filter((message) => message.method === 'Runtime.evaluate').length,
    1
  );
  for (const method of ['Page.captureScreenshot', 'DOM.getOuterHTML', 'Input.dispatchMouseEvent']) {
    const before = wire.sent.length;
    assert.match(
      (await wire.send(method, { nodeId: 1, type: 'mousePressed', x: 1, y: 1 }, parentSession))
        .error?.message ?? '',
      /^slicc: refused:/
    );
    assert.deepEqual(wire.clients(before), []);
  }
  for (const method of ['Runtime.evaluate', 'Page.captureScreenshot', 'DOM.getOuterHTML']) {
    const before = wire.sent.length;
    assert.match(
      (await wire.send(method, { expression: '1', nodeId: 1 }, childSession)).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.deepEqual(wire.clients(before), []);
  }
});

for (const type of ['worker', 'service_worker', 'shared_worker']) {
  test(`residual an unclassified ${type} with no URL stays closed`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('unknown-worker', type);
    entry.info.url = '';
    const answer = await wire.send('Target.attachToTarget', {
      targetId: 'unknown-worker',
      flatten: true,
    });
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.equal(
      wire.clients().some((message) => message.method === 'Target.attachToTarget'),
      false
    );
    entry.info.url = ordinary;
    const session = await wire.attach('unknown-worker');
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
      undefined
    );
  });
}
