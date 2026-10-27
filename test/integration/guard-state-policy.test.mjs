import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, ordinary, protocol } from './guard-state-fixture.mjs';

for (const method of [
  'Page.frameNavigated',
  'Page.frameAttached',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
  'Page.frameDetached',
]) {
  test(`state permitted lifecycle ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('policy-owner');
    const session = await wire.attach('policy-owner');
    await wire.send('Page.enable', {}, session);
    const frame = {
      ...errorFrame('policy-child', 'policy-owner'),
      name: 'synthetic-private-metadata',
      urlFragment: '#synthetic-private-metadata',
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-policy-owner',
      params: { frame },
    });
    await flush();
    const mark = wire.delivered.length;
    const params =
      method === 'Page.frameNavigated'
        ? { frame, type: 'Navigation', extra: 'synthetic-private-metadata' }
        : {
            frameId: 'policy-child',
            parentFrameId: 'policy-owner',
            url: failed,
            reason: 'swap',
            extra: 'synthetic-private-metadata',
          };
    wire.emit({ method, sessionId: session, params });
    await flush();
    const event = wire.delivered.slice(mark).find((message) => message.method === method);
    assert.ok(event);
    assert.equal(JSON.stringify(event).includes(failed), false);
    assert.equal(JSON.stringify(event).includes('synthetic-private-metadata'), false);
    if (method === 'Page.frameNavigated')
      assert.equal(event.params.frame.unreachableUrl, new URL(failed).origin);
    else assert.equal(event.params.url, new URL(failed).origin);
  });
}

for (const method of ['Target.targetCreated', 'Target.targetInfoChanged']) {
  test(`state permitted target ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('policy-target');
    const session = await wire.attach('policy-target');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-policy-target',
      params: { frame: errorFrame('policy-target') },
    });
    await flush();
    const mark = wire.delivered.length;
    wire.emit({
      method,
      sessionId: session,
      params: {
        targetInfo: {
          targetId: 'policy-target',
          type: 'page',
          url: 'chrome-error://chromewebdata/',
          title: failed,
        },
        extra: 'synthetic-private-metadata',
      },
    });
    await flush();
    const event = wire.delivered.slice(mark).find((message) => message.method === method);
    assert.ok(event);
    assert.equal(event.params.targetInfo.url, new URL(failed).origin);
    assert.equal(event.params.targetInfo.title, new URL(failed).origin);
    assert.equal(JSON.stringify(event).includes(failed), false);
    assert.equal(JSON.stringify(event).includes('synthetic-private-metadata'), false);
  });
}

for (const reference of ['frameId', 'frame', 'parentFrameId', 'context']) {
  test(`state future event ${reference}`, async (t) => {
    const wire = protocol(t);
    wire.target('future-owner');
    const session = await wire.attach('future-owner');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-future-owner',
      params: { frame: errorFrame('future-child', 'future-owner') },
    });
    await flush();
    const mark = wire.delivered.length;
    const value =
      reference === 'frame'
        ? { id: 'future-child' }
        : reference === 'context'
          ? { auxData: { frameId: 'future-child' } }
          : 'future-child';
    wire.emit({
      method: 'Page.syntheticFutureNotification',
      sessionId: session,
      params: { [reference]: value, text: 'synthetic-future-data', url: failed },
    });
    await flush();
    assert.equal(
      wire.delivered
        .slice(mark)
        .some((message) => message.method === 'Page.syntheticFutureNotification'),
      false
    );
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-future-data'),
      false
    );
  });
}

test('state named resources fail closed', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('resource-policy');
  const session = await wire.attach('resource-policy');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-resource-policy',
    params: { frame: errorFrame('resource-policy-child', 'resource-policy') },
  });
  entry.tree.resources = [
    { frameId: 'resource-policy-child', url: ordinary, type: 'Document' },
    { url: ordinary, type: 'Script' },
  ];
  const answer = await wire.send('Page.getFrameTree', {}, session);
  assert.deepEqual(answer.result.frameTree.resources, [{ url: ordinary, type: 'Script' }]);
});
