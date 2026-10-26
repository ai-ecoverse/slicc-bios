import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const refuse = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};
const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);

for (const method of ['Network.requestWillBeSent', 'Fetch.requestPaused']) {
  for (const failure of ['error', 'missing']) {
    test(`ordering unknown transport frame ${method} ${failure}`, { timeout: 5000 }, async (t) => {
      const wire = protocol(t);
      wire.target('transport');
      wire.target('unknown-frame', 'iframe');
      const session = await wire.attach('transport');
      await read(wire, session);
      await wire.send('Network.enable', {}, session);
      wire.hold(
        (message) =>
          (message.id >= 2 ** 30 &&
            message.method === 'Target.getTargetInfo' &&
            message.params.targetId === 'unknown-frame') ||
          (message.id < 2 ** 30 && message.method === 'Page.captureScreenshot')
      );
      const snapshot = wire.request('Page.captureScreenshot', {}, session);
      await flush();
      const pending = wire.held.find((message) => message.id === snapshot.id);
      assert.ok(pending);
      const marker = 'synthetic-unclassified-frame-payload';
      const mark = wire.delivered.length;
      wire.emit({
        method,
        sessionId: session,
        params: {
          requestId: 'unknown-request',
          frameId: 'unknown-frame',
          type: 'Other',
          resourceType: 'Script',
          request: { url: ordinary, postData: marker, headers: { 'X-Synthetic': marker } },
        },
      });
      await flush();
      const lookup = wire.held.find((message) => message.method === 'Target.getTargetInfo');
      assert.ok(lookup, 'the guard independently classifies the unknown frame');
      wire.release(
        lookup,
        failure === 'error'
          ? { error: { code: -32000, message: 'synthetic frame lookup error' } }
          : { result: {} }
      );
      await flush();
      wire.release(pending);
      refuse(await snapshot.answer);
      assert.equal(
        wire.delivered.slice(mark).some((message) => message.method === method),
        false
      );
      assert.equal(JSON.stringify(wire.delivered.slice(mark)).includes(marker), false);
      const sent = wire.sent.length;
      refuse(
        await wire.send(
          method === 'Fetch.requestPaused' ? 'Fetch.getResponseBody' : 'Network.getResponseBody',
          { requestId: 'unknown-request' },
          session
        )
      );
      assert.deepEqual(wire.clients(sent), []);
      wire.hold(() => false);
      assert.equal(
        (await read(wire, session)).error,
        undefined,
        'a fresh positive owner tree recovers harmless content'
      );
      wire.emit({
        method: 'Network.requestWillBeSent',
        sessionId: session,
        params: { requestId: 'ordinary-request', frameId: 'transport', request: { url: ordinary } },
      });
      await flush();
      assert.ok(
        wire.delivered.some(
          (message) =>
            message.method === 'Network.requestWillBeSent' &&
            message.params.requestId === 'ordinary-request'
        )
      );
    });
  }
}

for (const route of ['client', 'guard', 'navigation', 'nested', 'distinct-root']) {
  test(`ordering browser attachment retains observed owner ${route}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const rootId = route === 'distinct-root' ? 'root-frame' : 'owner';
    const root = { ...plainFrame(rootId), loaderId: 'synthetic-owner-loader' };
    const parent = wire.target('owner', 'page', root);
    const session = await wire.attach('owner');
    await read(wire, session);
    const parentFrameId = route === 'nested' ? 'intermediate' : rootId;
    const observation = route === 'guard' ? 'guard-owner' : session;
    if (route === 'nested') {
      wire.emit({
        method: 'Page.frameAttached',
        sessionId: observation,
        params: { frameId: 'intermediate', parentFrameId: rootId },
      });
    }
    wire.emit({
      method: route === 'navigation' ? 'Page.frameNavigated' : 'Page.frameAttached',
      sessionId: observation,
      params:
        route === 'navigation'
          ? { frame: plainFrame('child', parentFrameId) }
          : { frameId: 'child', parentFrameId },
    });
    await flush();
    const childFrame = plainFrame('child', parentFrameId);
    parent.tree.childFrames =
      route === 'nested'
        ? [{ frame: plainFrame('intermediate', rootId), childFrames: [{ frame: childFrame }] }]
        : [{ frame: childFrame }];
    const child = wire.target('child', 'iframe', childFrame);
    const attached = wire.attached('child');
    await flush();
    await flush();
    wire.emit({ method: 'Page.frameNavigated', sessionId: 'guard-owner', params: { frame: root } });
    assert.equal((await read(wire, session)).error, undefined);
    wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
    const snapshot = wire.request('Page.captureScreenshot', {}, session);
    await flush();
    const pending = wire.held.find((message) => message.id === snapshot.id);
    assert.ok(pending, 'the ordinary owner snapshot was admitted');
    const unsafe = errorFrame('child', parentFrameId);
    child.tree = { frame: unsafe };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: attached,
      params: { frame: unsafe, type: 'BackForwardCacheRestore' },
    });
    const sent = wire.sent.length;
    const content = read(wire, session);
    wire.release(pending);
    refuse(await snapshot.answer);
    refuse(await content);
    assert.deepEqual(wire.clients(sent), []);
  });
}
