import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-ordering-fixture.mjs';

for (const state of ['unconfirmed', 'failed-check', 'protected']) {
  test(`ordering transport remains closed ${state}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('transport');
    let session;
    if (state === 'unconfirmed') {
      wire.privateFailure(true);
      session = wire.attached('transport');
      await flush();
    } else {
      session = await wire.attach('transport');
      await wire.send('Network.enable', {}, session);
      await wire.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
      if (state === 'failed-check') wire.privateFailure(true);
      if (state === 'protected') entry.tree = { frame: errorFrame('transport') };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-transport',
        params: { frame: state === 'protected' ? entry.tree.frame : plainFrame('transport') },
      });
      await flush();
    }
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: session,
      params: {
        requestId: 'unchecked-request',
        frameId: 'transport',
        request: { url: ordinary, postData: 'synthetic-unchecked-transport' },
      },
    });
    wire.emit({
      method: 'Fetch.requestPaused',
      sessionId: session,
      params: {
        requestId: 'unchecked-pause',
        frameId: 'transport',
        resourceType: 'Document',
        request: { url: ordinary },
      },
    });
    await flush();
    assert.equal(
      wire.delivered.slice(mark).some((event) => /^(Network|Fetch)\./.test(event.method ?? '')),
      false
    );
    assert.ok(
      wire.sent.some(
        (message) =>
          message.method === 'Fetch.continueRequest' &&
          message.params.requestId === 'unchecked-pause'
      )
    );
  });
}

test('ordering ordinary caller interception does not admit response bodies or protected rewrites during navigation', async (t) => {
  const wire = protocol(t);
  wire.target('transport');
  const session = await wire.attach('transport');
  await wire.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: 'guard-transport',
    params: { frameId: 'transport', url: ordinary },
  });
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: session,
    params: {
      requestId: 'caller-pause',
      frameId: 'transport',
      resourceType: 'Document',
      request: { url: ordinary },
      responseStatusCode: 200,
    },
  });
  await flush();
  const mark = wire.sent.length;
  for (const [method, params] of [
    ['Fetch.getResponseBody', { requestId: 'caller-pause' }],
    ['Fetch.continueRequest', { requestId: 'caller-pause', url: failed }],
  ]) {
    const response = await wire.send(method, params, session);
    assert.match(response.error?.message ?? '', /^slicc: refused:/);
    assert.equal(response.result, undefined);
  }
  assert.deepEqual(wire.clients(mark), []);
  assert.equal(
    (
      await wire.send(
        'Fetch.fulfillRequest',
        { requestId: 'caller-pause', responseCode: 200, body: 'c3ludGhldGlj' },
        session
      )
    ).error,
    undefined
  );
});
