import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failed, flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
const enabled = async (wire, session) => {
  assert.equal((await read(wire, session)).error, undefined);
  assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
  assert.equal(
    (
      await wire.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*' }], handleAuthRequests: true },
        session
      )
    ).error,
    undefined
  );
};
const lifecycle = [
  ['Page.frameNavigated', { frame: { ...plainFrame('live'), name: failed } }],
  ['Page.frameAttached', { frameId: 'live-child', parentFrameId: 'live' }],
  [
    'Page.frameStartedNavigating',
    { frameId: 'live', url: ordinary, navigationType: 'differentDocument' },
  ],
  ['Page.frameStartedLoading', { frameId: 'live' }],
  ['Page.frameStoppedLoading', { frameId: 'live' }],
  ['Page.navigatedWithinDocument', { frameId: 'live', url: `${ordinary}#ordinary` }],
  [
    'Page.lifecycleEvent',
    { frameId: 'live', loaderId: 'synthetic-loader', name: 'DOMContentLoaded', timestamp: 1 },
  ],
  ['Page.domContentEventFired', { timestamp: 1 }],
  ['Page.loadEventFired', { timestamp: 2 }],
  ['Page.frameDetached', { frameId: 'live-child', reason: 'remove' }],
];

test('ordering ordinary lifecycle', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.target('live');
  const session = await wire.attach('live');
  await enabled(wire, session);
  const mark = wire.delivered.length;
  for (const [method, params] of lifecycle) wire.emit({ method, sessionId: session, params });
  await flush();
  assert.deepEqual(
    wire.delivered.slice(mark).map((message) => message.method),
    lifecycle.map(([method]) => method),
    'ordinary navigation and lifecycle metadata stay observable'
  );
  assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
  assert.equal((await read(wire, session)).error, undefined);
});

const pauses = [
  ['request', 'Fetch.requestPaused', {}, 'Fetch.continueRequest'],
  ['response', 'Fetch.requestPaused', { responseStatusCode: 200 }, 'Fetch.continueResponse'],
  [
    'response-error',
    'Fetch.requestPaused',
    { responseErrorReason: 'Failed' },
    'Fetch.continueResponse',
  ],
  [
    'auth',
    'Fetch.authRequired',
    { authChallenge: { source: 'Server', origin: ordinary, scheme: 'basic', realm: 'synthetic' } },
    'Fetch.continueWithAuth',
  ],
];

for (const [stage, method, fields, continuation] of pauses) {
  test(`ordering ordinary pause ${stage}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('live');
    const session = await wire.attach('live');
    await enabled(wire, session);
    const sent = wire.sent.length;
    const delivered = wire.delivered.length;
    const requestId = `synthetic-${stage}`;
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: session,
      params: { frameId: 'live', url: ordinary },
    });
    wire.emit({
      method,
      sessionId: session,
      params: {
        requestId,
        frameId: 'live',
        resourceType: 'Document',
        request: { url: ordinary, headers: {} },
        ...fields,
      },
    });
    await flush();
    const shown = wire.delivered
      .slice(delivered)
      .some((message) => message.method === method && message.params.requestId === requestId);
    const released = wire.sent
      .slice(sent)
      .filter(
        (message) =>
          message.params?.requestId === requestId &&
          [continuation, 'Fetch.failRequest'].includes(message.method)
      );
    assert.equal(
      shown || released.length === 1,
      true,
      'the browser is not left waiting for an inaccessible pause'
    );
    if (released.length) {
      assert.equal(released[0].method, continuation);
      if (stage === 'auth')
        assert.deepEqual(released[0].params.authChallengeResponse, { response: 'Default' });
    }
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: plainFrame('live') },
    });
    assert.equal((await read(wire, session)).error, undefined);
  });
}

test('ordering pause publication race', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.target('live');
  const session = await wire.attach('live');
  await enabled(wire, session);
  wire.target('pause-frame');
  wire.hold(
    (message) =>
      message.method === 'Target.getTargetInfo' && message.params.targetId === 'pause-frame'
  );
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: session,
    params: {
      requestId: 'synthetic-race',
      frameId: 'pause-frame',
      resourceType: 'Document',
      request: { url: ordinary, headers: {} },
    },
  });
  await flush();
  const lookup = wire.held.find((message) => message.params?.targetId === 'pause-frame');
  assert.ok(lookup);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: plainFrame('live') },
  });
  const current = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
  await flush();
  assert.ok(wire.clients().some((message) => message.id === current.id));
  wire.release(lookup);
  assert.equal((await current.answer).error, undefined);
  await flush();
  const shown = wire.delivered
    .slice(mark)
    .some(
      (message) =>
        message.method === 'Fetch.requestPaused' && message.params.requestId === 'synthetic-race'
    );
  const released = wire.sent.filter(
    (message) =>
      message.method === 'Fetch.continueRequest' && message.params.requestId === 'synthetic-race'
  );
  assert.equal(
    shown || released.length === 1,
    true,
    'a pause invalidated during its check is still settled'
  );
});
