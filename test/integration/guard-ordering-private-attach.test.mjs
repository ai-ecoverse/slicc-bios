import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const order of ['event-first', 'reply-first']) {
  test(`ordering retired private attach ${order}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('parent');
    const parent = await wire.attach('parent');
    const childEntry = wire.target('child', 'iframe', plainFrame('child', 'parent'), 'parent');
    entry.tree.childFrames = [{ frame: childEntry.tree.frame }];
    wire.hold(
      (message) =>
        message.method === 'Target.attachToTarget' &&
        message.id >= 2 ** 30 &&
        message.params.targetId === 'child'
    );
    wire.attached('child', parent);
    await flush();
    const attach = wire.held.find((message) => message.method === 'Target.attachToTarget');
    assert.ok(attach);
    delete entry.tree.childFrames;
    wire.emit({
      method: 'Page.frameDetached',
      sessionId: parent,
      params: { frameId: 'child', reason: 'remove' },
    });
    await flush();
    childEntry.info = { ...childEntry.info, url: 'chrome-error://chromewebdata/', title: failed };
    childEntry.tree = { frame: errorFrame('child', 'parent') };
    wire.sessions.set('guard-child', 'child');
    const mark = wire.sent.length;
    const event = {
      method: 'Target.attachedToTarget',
      params: { sessionId: 'guard-child', targetInfo: childEntry.info, waitingForDebugger: false },
    };
    if (order === 'event-first') wire.emit(event);
    wire.release(attach);
    if (order === 'reply-first') {
      await flush();
      wire.emit(event);
    }
    await flush();
    await flush();
    assert.equal(
      JSON.stringify(wire.delivered).includes(failed),
      false,
      'the retired attachment stays private'
    );
    assert.equal(
      wire.delivered.some(
        (message) =>
          message.method === 'Target.attachedToTarget' && message.params.sessionId === 'guard-child'
      ),
      false
    );
    assert.ok(
      wire.sent
        .slice(mark)
        .some(
          (message) =>
            message.method === 'Target.detachFromTarget' &&
            message.params.sessionId === 'guard-child'
        )
    );
    assert.equal(
      wire.sent
        .slice(mark)
        .some(
          (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-child'
        ),
      false,
      'the retired session never acquires a public watcher'
    );
    assert.equal(
      wire.sent
        .slice(mark)
        .some(
          (message) =>
            message.method === 'Target.attachToTarget' && message.params.targetId === 'child'
        ),
      false
    );
    wire.hold(() => false);
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, parent)).error,
      undefined
    );
  });
}

test('ordering subscriber stale proof recovery', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('subscriber');
  const session = await wire.attach('subscriber');
  await wire.send('Runtime.enable', {}, session);
  wire.hold(
    (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-subscriber'
  );
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-subscriber',
    params: { frame: plainFrame('subscriber') },
  });
  await flush();
  const stale = wire.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(stale);
  entry.tree = { frame: errorFrame('subscriber') };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-subscriber',
    params: { frame: entry.tree.frame },
  });
  const emit = (marker) =>
    wire.emit({
      method: 'Runtime.consoleAPICalled',
      sessionId: session,
      params: { type: 'log', args: [{ type: 'string', value: marker }] },
    });
  emit('synthetic-unchecked');
  wire.release(stale, { result: { frameTree: { frame: plainFrame('subscriber') } } });
  await flush();
  for (const probe of [...wire.held]) wire.release(probe);
  await flush();
  emit('synthetic-protected');
  await flush();
  assert.equal(JSON.stringify(wire.delivered).includes('synthetic-unchecked'), false);
  assert.equal(JSON.stringify(wire.delivered).includes('synthetic-protected'), false);
  wire.hold(() => false);
  entry.tree = { frame: plainFrame('subscriber') };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-subscriber',
    params: { frame: entry.tree.frame },
  });
  await flush();
  emit('synthetic-current');
  await flush();
  assert.equal(JSON.stringify(wire.delivered).includes('synthetic-current'), true);
});
