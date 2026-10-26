import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const order of ['parent-first', 'child-first', 'parent-first-alias', 'child-first-alias']) {
  test(`duplicate child commit invalidates the owning document ${order}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const alias = order.endsWith('alias');
    const parentFrame = alias ? 'parent-frame' : 'parent';
    const childFrame = alias ? 'child-frame' : 'child';
    const parentEntry = wire.target('parent', 'page', plainFrame(parentFrame));
    const parent = await wire.attach('parent');
    const childEntry = wire.target(
      'child',
      'iframe',
      plainFrame(childFrame, parentFrame),
      alias ? undefined : 'parent'
    );
    parentEntry.tree.childFrames = [{ frame: childEntry.tree.frame }];
    const child = wire.attached('child', alias ? undefined : parent);
    await flush();
    await flush();
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, child)).error,
      undefined
    );
    childEntry.tree = {
      frame: { ...errorFrame(childFrame, parentFrame), loaderId: 'synthetic-private-loader' },
    };
    delete parentEntry.tree.childFrames;
    const mark = wire.sent.length;
    for (const sessionId of order.startsWith('parent-first') ? [parent, child] : [child, parent])
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId,
        params: { frame: childEntry.tree.frame, type: 'BackForwardCacheRestore' },
      });
    await flush();
    const answer = await wire.send('Runtime.evaluate', { expression: 'document.title' }, child);
    assert.equal(
      JSON.stringify(wire.delivered).includes(failed),
      false,
      'the private error-document payload never reaches the client'
    );
    assert.match(
      answer.error?.message ?? '',
      /^slicc: refused:/,
      'every owning/related document is invalidated by the physical child commit'
    );
    assert.equal(answer.result, undefined);
    assert.equal(
      wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
      false,
      'no client content reaches the restored private child'
    );
  });
}

test('parent-first private commit revokes child transport before its duplicate notification', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('parent');
  const parent = await wire.attach('parent');
  const childEntry = wire.target('child', 'iframe', plainFrame('child', 'parent'), 'parent');
  entry.tree.childFrames = [childEntry.tree];
  const child = wire.attached('child', parent);
  await flush();
  await wire.send('Network.enable', {}, child);
  childEntry.tree = {
    frame: { ...errorFrame('child', 'parent'), loaderId: 'synthetic-private-loader' },
  };
  entry.tree.childFrames = [];
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: parent,
    params: { frame: childEntry.tree.frame, type: 'BackForwardCacheRestore' },
  });
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: child,
    params: {
      requestId: 'private-window',
      frameId: 'child',
      request: { url: 'https://ordinary.invalid/request', postData: 'synthetic-private-window' },
    },
  });
  await flush();
  assert.equal(
    JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-private-window'),
    false
  );
});
