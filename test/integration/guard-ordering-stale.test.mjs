import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

test('ordering A in-flight check', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('a');
  const client = await wire.attach('a');
  wire.hold((message) => message.method === 'Page.getFrameTree');
  const mark = wire.sent.length;
  const read = wire.send('Runtime.evaluate', { expression: 'document.title' }, client);
  await flush();
  const stale = wire.held.find((message) => message.method === 'Page.getFrameTree');
  const frame = errorFrame('a');
  entry.tree = { frame };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: client,
    params: { frame, type: 'BackForwardCacheRestore' },
  });
  if (stale) wire.release(stale, { result: { frameTree: { frame: plainFrame('a') } } });
  const answer = await read;
  assert.deepEqual(wire.clients(mark), [], 'a stale check forwarded no client command');
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
});

test('ordering A pending answer', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('a');
  const session = await wire.attach('a');
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
  const shot = wire.request('Page.captureScreenshot', {}, session);
  await flush();
  const pending = wire.held.find((message) => message.id === shot.id);
  const frame = errorFrame('a');
  entry.tree = { frame };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame, type: 'BackForwardCacheRestore' },
  });
  wire.release(pending);
  const answer = await shot.answer;
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
});

test('ordering B pending answer', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('parent');
  const parent = await wire.attach('parent');
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Runtime.evaluate');
  const content = wire.request('Runtime.evaluate', { expression: 'document.title' }, parent);
  await flush();
  const pending = wire.held.find((message) => message.id === content.id);
  const frame = errorFrame('child', 'parent');
  wire.target('child', 'iframe', frame, 'parent');
  entry.tree.childFrames = [{ frame }];
  wire.attached('child', parent);
  wire.release(pending, { result: { result: { value: { failedUrl: failed } } } });
  const answer = await content.answer;
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
  assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
});

test('ordering A answer generation', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('a');
  const session = await wire.attach('a');
  wire.hold(
    (message) =>
      message.id < 2 ** 30 &&
      ['Page.captureScreenshot', 'Runtime.evaluate'].includes(message.method)
  );
  const shot = wire.request('Page.captureScreenshot', {}, session);
  const content = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
  await flush();
  const image = wire.held.find((message) => message.id === shot.id);
  const value = wire.held.find((message) => message.id === content.id);
  const frame = errorFrame('a');
  entry.tree = { frame };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame, type: 'BackForwardCacheRestore' },
  });
  entry.tree = { frame: plainFrame('a') };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-a',
    params: { frame: entry.tree.frame },
  });
  wire.hold(() => false);
  const current = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
  assert.equal(current.error, undefined);
  wire.release(image);
  wire.release(value, { result: { result: { value: { failedUrl: failed } } } });
  for (const answer of await Promise.all([shot.answer, content.answer])) {
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
  }
  assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
});
