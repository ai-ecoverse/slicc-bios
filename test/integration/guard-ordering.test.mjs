import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const refusal = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};

for (const order of ['client', 'guard']) {
  test(`ordering A ${order}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const page = wire.target('a');
    const session = await wire.attach('a');
    wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
    const shot = wire.request('Page.captureScreenshot', {}, session);
    await flush();
    const pending = wire.held.find((message) => message.id === shot.id);
    const frame = errorFrame('a');
    page.tree = { frame };
    const mark = wire.sent.length;
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: order === 'client' ? session : 'guard-a',
      params: { frame, type: 'BackForwardCacheRestore' },
    });
    const read = wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    wire.release(pending);
    const answers = await Promise.all([read, shot.answer]);
    await flush();
    const forwarded = wire.clients(mark);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: order === 'client' ? 'guard-a' : session,
      params: { frame, type: 'BackForwardCacheRestore' },
    });
    assert.deepEqual(forwarded, [], 'the protocol forwarded no client command');
    answers.forEach(refusal);
  });
}

test('ordering B attach', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const parent = wire.target('parent');
  const session = await wire.attach('parent');
  wire.hold(
    (message) =>
      (message.id < 2 ** 30 && message.method === 'Page.captureScreenshot') ||
      (message.sessionId === 'guard-child' && message.method === 'Page.getFrameTree')
  );
  const shot = wire.request('Page.captureScreenshot', {}, session);
  await flush();
  const pending = wire.held.find((message) => message.id === shot.id);
  const frame = errorFrame('child', 'parent');
  wire.target('child', 'iframe', frame, 'parent');
  parent.tree.childFrames = [{ frame }];
  const child = wire.attached('child', session);
  const mark = wire.sent.length;
  const early = wire.send('Runtime.evaluate', { expression: 'document.title' }, child);
  await flush();
  const reads = [
    early,
    wire.send('Runtime.evaluate', { expression: 'document.title' }, child),
    wire.send('Runtime.evaluate', { expression: 'loadTimeData' }, child),
    wire.send('DOM.getDocument', {}, child),
    wire.send('DOM.getOuterHTML', { nodeId: 1 }, child),
  ];
  await flush();
  wire.hold(() => false);
  const probe = wire.held.find((message) => message.method === 'Page.getFrameTree');
  if (probe) wire.release(probe);
  wire.release(pending);
  const answers = await Promise.all([...reads, shot.answer]);
  const forwarded = wire.clients(mark);
  assert.deepEqual(forwarded, [], 'the protocol forwarded no client content');
  answers.forEach(refusal);
  assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
});

for (const initial of ['error', 'ordinary']) {
  test(`ordering B uncertainty and recovery ${initial}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('parent');
    const parent = await wire.attach('parent');
    const frame =
      initial === 'error' ? errorFrame('child', 'parent') : plainFrame('child', 'parent');
    const entry = wire.target('child', 'iframe', frame, 'parent');
    wire.hold(
      (message) => message.sessionId === 'guard-child' && message.method === 'Page.getFrameTree'
    );
    const child = wire.attached('child', parent);
    await flush();
    const mark = wire.sent.length;
    const pendingRead = wire.send('Runtime.evaluate', { expression: 'document.title' }, child);
    await flush();
    const blocked = wire.clients(mark);
    const probe = wire.held.find((message) => message.method === 'Page.getFrameTree');
    if (probe) wire.release(probe, { error: { code: -32000, message: 'synthetic uncertainty' } });
    const uncertain = await pendingRead;
    wire.hold(() => false);
    entry.tree = { frame: plainFrame('child', 'parent') };
    const recovered = await wire.send('Runtime.evaluate', { expression: 'document.title' }, child);
    assert.deepEqual(blocked, [], 'an uncertain tree forwarded no content');
    refusal(uncertain);
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.result?.result?.value, 'synthetic-content');
  });
}
