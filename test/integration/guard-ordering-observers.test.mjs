import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-ordering-fixture.mjs';

for (const stage of ['Request', 'Response']) {
  test(`ordinary caller Fetch interception survives navigation ${stage}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('live');
    const session = await wire.attach('live');
    await wire.send('Page.enable', {}, session);
    await wire.send('Runtime.evaluate', { expression: '1' }, session);
    await wire.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: stage }] },
      session
    );
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: 'guard-live',
      params: {
        frameId: 'live',
        url: ordinary,
        loaderId: 'synthetic-loader',
        navigationType: 'differentDocument',
      },
    });
    const sent = wire.sent.length;
    const delivered = wire.delivered.length;
    const requestId = `synthetic-${stage}`;
    wire.emit({
      method: 'Fetch.requestPaused',
      sessionId: session,
      params: {
        requestId,
        frameId: 'live',
        resourceType: 'Document',
        request: { url: ordinary, headers: {} },
        ...(stage === 'Response' ? { responseStatusCode: 200 } : {}),
      },
    });
    await flush();
    const published = wire.delivered
      .slice(delivered)
      .some(
        (message) =>
          message.method === 'Fetch.requestPaused' && message.params.requestId === requestId
      );
    const autoReleased = wire.sent
      .slice(sent)
      .filter(
        (message) =>
          message.params?.requestId === requestId &&
          ['Fetch.continueRequest', 'Fetch.continueResponse', 'Fetch.failRequest'].includes(
            message.method
          )
      );
    assert.equal(
      published,
      true,
      'the ordinary caller retains its explicitly requested interception'
    );
    assert.deepEqual(
      autoReleased,
      [],
      'ordinary interception is not silently continued by the guard'
    );
    const answer = await wire.send(
      'Fetch.fulfillRequest',
      { requestId, responseCode: 200, body: 'c3ludGhldGlj' },
      session
    );
    assert.equal(answer.error, undefined, 'the caller can settle the pause it was offered');
  });
}

test('Network-only subscriber observes an ordinary post-navigation request and failure', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.target('live');
  const session = await wire.attach('live');
  await wire.send('Network.enable', {}, session);
  await wire.send('Runtime.evaluate', { expression: '1' }, session);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: plainFrame('live') },
  });
  await flush();
  await flush();
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'synthetic-network',
      frameId: 'live',
      type: 'Document',
      request: { url: ordinary },
    },
  });
  wire.emit({
    method: 'Network.loadingFailed',
    sessionId: session,
    params: {
      requestId: 'synthetic-network',
      type: 'Document',
      errorText: 'net::ERR_CONNECTION_REFUSED',
      canceled: false,
      timestamp: 1,
    },
  });
  await flush();
  assert.deepEqual(
    wire.delivered.slice(mark).map((message) => message.method),
    ['Network.requestWillBeSent', 'Network.loadingFailed'],
    'Network.enable does not depend on a Runtime subscription or an unrelated new content read'
  );
});

test('ordinary navigation keeps redacted redirect extra headers observable', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.target('live');
  const session = await wire.attach('live');
  await wire.send('Network.enable', {}, session);
  await wire.send('Runtime.enable', {}, session);
  await wire.send('Runtime.evaluate', { expression: '1' }, session);
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'synthetic-redirect',
      frameId: 'live',
      type: 'Document',
      request: { url: ordinary },
    },
  });
  await flush();
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: 'guard-live',
    params: {
      frameId: 'live',
      url: ordinary,
      loaderId: 'synthetic-loader',
      navigationType: 'differentDocument',
    },
  });
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Network.responseReceivedExtraInfo',
    sessionId: session,
    params: {
      requestId: 'synthetic-redirect',
      statusCode: 302,
      headers: { Location: `${protectedOrigin}/synthetic-redirect-capability` },
    },
  });
  await flush();
  const extra = wire.delivered
    .slice(mark)
    .filter((message) => message.method === 'Network.responseReceivedExtraInfo');
  assert.equal(
    extra.length,
    1,
    'the redacted redirect metadata remains observable during ordinary navigation'
  );
  assert.equal(extra[0].params.headers.Location, protectedOrigin);
  assert.equal(JSON.stringify(extra).includes('synthetic-redirect-capability'), false);
});

for (const kind of ['ordinary', 'ordinary-error']) {
  test(`ordinary parent settles a child navigation reported across sessions ${kind}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const parentEntry = wire.target('live');
    const parent = await wire.attach('live');
    await wire.send('Runtime.evaluate', { expression: '1' }, parent);
    wire.emit({
      method: 'Page.frameAttached',
      sessionId: 'guard-live',
      params: { frameId: 'child', parentFrameId: 'live' },
    });
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: 'guard-live',
      params: {
        frameId: 'child',
        url: ordinary,
        loaderId: 'synthetic-child-loader',
        navigationType: 'differentDocument',
      },
    });
    const frame =
      kind === 'ordinary'
        ? plainFrame('child', 'live')
        : {
            id: 'child',
            parentId: 'live',
            url: 'chrome-error://chromewebdata/',
            securityOrigin: '://',
            unreachableUrl: 'https://network-error.invalid/synthetic',
          };
    wire.target('child', 'iframe', frame, 'live');
    parentEntry.tree.childFrames = [{ frame }];
    wire.attached('child', parent);
    await flush();
    await flush();
    wire.emit({ method: 'Page.frameNavigated', sessionId: 'guard-child', params: { frame } });
    wire.emit({
      method: 'Page.frameStoppedLoading',
      sessionId: 'guard-child',
      params: { frameId: 'child' },
    });
    await flush();
    const answers = await Promise.all([
      wire.send('Runtime.evaluate', { expression: '1' }, parent),
      wire.send('DOM.getDocument', {}, parent),
      wire.send('Page.captureScreenshot', {}, parent),
    ]);
    assert.deepEqual(
      answers.map((answer) => answer.error),
      [undefined, undefined, undefined],
      'a committed/stopped ordinary child settles the parent opening state across related sessions'
    );
  });
}
