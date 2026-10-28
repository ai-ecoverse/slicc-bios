import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { failed, flush, ordinary, plainFrame, protocol } from './guard-state-fixture.mjs';

function protectChild(wire, owner, root) {
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${owner}`,
    params: { frame: { ...plainFrame('boundary-child', root), url: failed } },
  });
}

for (const method of ['Page.printToPDF', 'Page.getResourceContent', 'Page.searchInResource']) {
  test(`the whole-page boundary refuses ${method} without forwarding`, async (t) => {
    const wire = protocol(t);
    wire.target('boundary-owner', 'page', plainFrame('boundary-root'));
    const session = await wire.attach('boundary-owner');
    protectChild(wire, 'boundary-owner', 'boundary-root');
    await flush();
    const sent = wire.sent.length;
    const answer = await wire.send(method, {}, session);
    assert.equal(answer.error?.message, PROTECTED);
    assert.deepEqual(wire.clients(sent), []);
  });
}

for (const method of ['Page.printToPDF', 'Page.getResourceContent']) {
  test(`a ${method} answer arriving after the lock is not published`, async (t) => {
    const wire = protocol(t);
    wire.target('late-boundary-owner', 'page', plainFrame('late-boundary-root'));
    const session = await wire.attach('late-boundary-owner');
    wire.hold((message) => message.id < 2 ** 30 && message.method === method);
    const request = wire.request(method, {}, session);
    await flush();
    const held = wire.held.find((message) => message.id === request.id);
    assert.ok(held);
    protectChild(wire, 'late-boundary-owner', 'late-boundary-root');
    wire.release(held, {
      result:
        method === 'Page.printToPDF'
          ? { data: Buffer.from('synthetic-boundary-content').toString('base64') }
          : { content: 'synthetic-boundary-content', base64Encoded: false },
    });
    const answer = await request.answer;
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(answer.result, undefined);
  });
}

test('a refused screenshot does not prevent recovery when the protected child is removed', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('recovery-owner', 'page', plainFrame('recovery-root'));
  const session = await wire.attach('recovery-owner');
  const child = { ...plainFrame('boundary-child', 'recovery-root'), url: failed };
  entry.tree.childFrames = [{ frame: child }];
  protectChild(wire, 'recovery-owner', 'recovery-root');
  await flush();
  const sent = wire.sent.length;
  assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error?.message, PROTECTED);
  assert.deepEqual(wire.clients(sent), []);
  entry.tree.childFrames = [];
  wire.emit({
    method: 'Page.frameDetached',
    sessionId: 'guard-recovery-owner',
    params: { frameId: 'boundary-child', reason: 'remove' },
  });
  await flush();
  for (const method of ['Page.enable', 'Runtime.evaluate', 'Page.captureScreenshot'])
    assert.equal((await wire.send(method, {}, session)).error, undefined);
});

for (const previous of ['ordinary', 'protected']) {
  test(`a placed child swapped from ${previous} to an ordinary document recovers the page`, async (t) => {
    const wire = protocol(t);
    wire.target('swap-boundary-owner', 'page', plainFrame('swap-boundary-root'));
    const session = await wire.attach('swap-boundary-owner');
    const child = wire.target(
      'swap-boundary-child',
      'iframe',
      plainFrame('swap-boundary-child', 'swap-boundary-root')
    );
    await wire.attach('swap-boundary-child');
    if (previous === 'protected')
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-swap-boundary-child',
        params: { frame: { ...child.tree.frame, url: failed } },
      });
    await flush();
    child.tree.frame = { ...child.tree.frame, url: `${ordinary}?replacement` };
    wire.emit({
      method: 'Page.frameDetached',
      sessionId: 'guard-swap-boundary-owner',
      params: { frameId: 'swap-boundary-child', reason: 'swap' },
    });
    await flush();
    for (const method of ['Page.captureScreenshot', 'DOM.getDocument'])
      assert.equal((await wire.send(method, {}, session)).error, undefined);
  });
}

test('an unplaced swapped child stays closed while its owner is still observed', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('unplaced-swap-owner', 'page', plainFrame('unplaced-swap-root'));
  const session = await wire.attach('unplaced-swap-owner');
  const child = wire.target(
    'unplaced-swap-child',
    'iframe',
    plainFrame('unplaced-swap-child', 'unplaced-swap-root')
  );
  wire.emit({ method: 'Target.targetCreated', params: { targetInfo: child.info } });
  entry.tree.childFrames = [{ frame: child.tree.frame }];
  wire.emit({
    method: 'Page.frameAttached',
    sessionId: 'guard-unplaced-swap-owner',
    params: { frameId: 'unplaced-swap-child', parentFrameId: 'unplaced-swap-root' },
  });
  wire.emit({
    method: 'Page.frameDetached',
    sessionId: 'guard-unplaced-swap-owner',
    params: { frameId: 'unplaced-swap-child', reason: 'swap' },
  });
  await flush();
  const sent = wire.sent.length;
  assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error?.message, PROTECTED);
  assert.deepEqual(wire.clients(sent), []);
});
