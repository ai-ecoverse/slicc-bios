import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

test('a previously seen commit is fresh after detached observation and an ordinary proof', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('live');
  const original = await wire.attach('live');
  await wire.send('Runtime.evaluate', { expression: '1' }, original);
  const restored = { ...errorFrame('live'), loaderId: 'synthetic-private-loader' };
  entry.tree = { frame: restored };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: restored, type: 'BackForwardCacheRestore' },
  });
  assert.match(
    (await wire.send('Runtime.evaluate', { expression: 'document.title' }, original)).error
      ?.message ?? '',
    /^slicc: refused:/
  );
  wire.emit({
    method: 'Target.detachedFromTarget',
    params: { sessionId: original, targetId: 'live' },
  });
  wire.emit({
    method: 'Target.detachedFromTarget',
    params: { sessionId: 'guard-live', targetId: 'live' },
  });
  await flush();
  entry.tree = { frame: { ...plainFrame('live'), loaderId: 'synthetic-ordinary-loader' } };
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Target.attachToTarget');
  const reattach = wire.request('Target.attachToTarget', { targetId: 'live', flatten: true });
  await flush();
  const pending = wire.held.find((message) => message.id === reattach.id);
  assert.ok(pending);
  const current = 'client-live-current';
  wire.sessions.set(current, 'live');
  wire.release(pending, { result: { sessionId: current } });
  assert.equal((await reattach.answer).error, undefined);
  wire.hold(() => false);
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '1' }, current)).error,
    undefined,
    'a fresh ordinary proof after the observation gap is usable'
  );
  entry.tree = { frame: restored };
  const mark = wire.sent.length;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: restored, type: 'BackForwardCacheRestore' },
  });
  const answer = await wire.send('Runtime.evaluate', { expression: 'document.title' }, current);
  assert.equal(
    JSON.stringify(wire.delivered).includes(failed),
    false,
    'an old dedup signature cannot authenticate the newly restored private document'
  );
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
  assert.equal(
    wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
    false
  );
});

for (const namespace of ['same', 'alias']) {
  test(`fresh independent classification replaces historical commit state ${namespace}`, async (t) => {
    const wire = protocol(t);
    const frameId = namespace === 'alias' ? 'actual-frame' : 'live';
    const entry = wire.target('live', 'page', {
      ...plainFrame(frameId),
      loaderId: 'synthetic-initial-loader',
    });
    const session = await wire.attach('live');
    await wire.send('Runtime.evaluate', { expression: '1' }, session);
    const old = { ...errorFrame(frameId), loaderId: 'synthetic-old-private-loader' };
    entry.tree = { frame: old };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-live',
      params: { frame: old, type: 'BackForwardCacheRestore' },
    });
    assert.match(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error?.message ?? '',
      /^slicc: refused:/
    );
    entry.tree = {
      frame: { ...plainFrame(frameId), loaderId: 'synthetic-current-ordinary-loader' },
    };
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
      undefined,
      'an independent ordinary read can recover without a notification'
    );
    entry.tree = { frame: old };
    const mark = wire.sent.length;
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-live',
      params: { frame: old, type: 'BackForwardCacheRestore' },
    });
    const answer = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
    assert.equal(
      wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
      false
    );
  });
}
