import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { failed, flush, ordinary, plainFrame, protocol } from './guard-state-fixture.mjs';

async function page(t) {
  const wire = protocol(t);
  const entry = wire.target('load-owner');
  const session = await wire.attach('load-owner');
  return { wire, entry, session };
}

function start(wire, loaderId, sessionId = 'guard-load-owner', frameId = 'load-owner') {
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId,
    params: { frameId, url: failed, loaderId, navigationType: 'historyDifferentDocument' },
  });
}

function request(wire, loaderId) {
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: 'guard-load-owner',
    params: {
      requestId: loaderId,
      loaderId,
      frameId: 'load-owner',
      type: 'Document',
      request: { url: failed },
      documentURL: failed,
    },
  });
}

for (const kind of ['same', 'different']) {
  test(`protected child start does not lock its ${kind}-id ordinary parent (#1115)`, async (t) => {
    const wire = protocol(t);
    const root = kind === 'same' ? 'load-owner' : 'load-root';
    wire.target('load-owner', 'page', plainFrame(root));
    const session = await wire.attach('load-owner');
    start(wire, 'child-loader', 'guard-load-owner', 'load-child');
    wire.emit({
      method: 'Fetch.requestPaused',
      sessionId: 'guard-load-owner',
      params: {
        requestId: 'child-request',
        networkId: 'child-loader',
        frameId: 'load-child',
        resourceType: 'Document',
        request: { url: failed },
      },
    });
    await flush();
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
      undefined
    );
  });
}

for (const ending of [
  'Network.loadingFailed',
  'Fetch.failRequest',
  'Page.stopLoading',
  'Page.frameStoppedLoading',
]) {
  test(`uncommitted protected main load settles after ${ending}`, async (t) => {
    const { wire, session } = await page(t);
    start(wire, 'ended-loader');
    request(wire, 'ended-loader');
    await flush();
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
    if (ending === 'Network.loadingFailed')
      wire.emit({
        method: ending,
        sessionId: 'guard-load-owner',
        params: { requestId: 'ended-loader', type: 'Document', errorText: 'net::ERR_ABORTED' },
      });
    if (ending === 'Fetch.failRequest')
      wire.emit({
        method: 'Fetch.requestPaused',
        sessionId: 'guard-load-owner',
        params: {
          requestId: 'ended-fetch',
          networkId: 'ended-loader',
          frameId: 'load-owner',
          resourceType: 'Document',
          request: { url: failed },
        },
      });
    if (ending === 'Page.frameStoppedLoading')
      wire.emit({
        method: ending,
        sessionId: 'guard-load-owner',
        params: { frameId: 'load-owner' },
      });
    if (ending === 'Page.stopLoading')
      assert.equal((await wire.send(ending, {}, session)).error, undefined);
    await flush();
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error, undefined);
    assert.equal((await wire.send('Input.dispatchKeyEvent', {}, session)).error, undefined);
  });
}

for (const ending of ['Network.loadingFailed', 'Fetch.failRequest', 'Page.stopLoading']) {
  test(`stale ${ending} cannot settle a newer protected main restore`, async (t) => {
    const { wire, session } = await page(t);
    start(wire, 'old-loader');
    request(wire, 'old-loader');
    await flush();
    t.after(() => {
      wire.hold(() => false);
      for (const message of [...wire.held]) wire.release(message);
    });
    let pending;
    if (ending === 'Page.stopLoading') {
      wire.hold((message) => message.method === ending && message.id < 2 ** 30);
      pending = wire.request(ending, {}, session);
    }
    if (ending === 'Fetch.failRequest') {
      wire.hold((message) => message.method === ending);
      wire.emit({
        method: 'Fetch.requestPaused',
        sessionId: 'guard-load-owner',
        params: {
          requestId: 'old-fetch',
          networkId: 'old-loader',
          frameId: 'load-owner',
          resourceType: 'Document',
          request: { url: failed },
        },
      });
    }
    await flush();
    start(wire, 'new-loader');
    request(wire, 'new-loader');
    if (ending === 'Network.loadingFailed')
      wire.emit({
        method: ending,
        sessionId: 'guard-load-owner',
        params: { requestId: 'old-loader', type: 'Document', errorText: 'net::ERR_ABORTED' },
      });
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
    if (pending) await pending.answer;
    await flush();
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
    assert.equal(
      (await wire.send('Input.dispatchKeyEvent', {}, session)).error?.message,
      PROTECTED
    );
  });
}

test('an older guardian stop cannot settle a newer restore seen only on the client stream', async (t) => {
  const { wire, session } = await page(t);
  start(wire, 'old-loader');
  start(wire, 'new-loader', session);
  wire.emit({
    method: 'Page.frameStoppedLoading',
    sessionId: 'guard-load-owner',
    params: { frameId: 'load-owner' },
  });
  await flush();
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
});

test('duplicate old main commit and child stop cannot settle a protected main restore', async (t) => {
  const { wire, entry, session } = await page(t);
  start(wire, 'pending-loader');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: { ...entry.tree.frame, loaderId: 'old-document' } },
  });
  wire.emit({
    method: 'Page.frameStoppedLoading',
    sessionId: 'guard-load-owner',
    params: { frameId: 'load-child' },
  });
  await flush();
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  assert.equal((await wire.send('Page.navigate', { url: ordinary }, session)).error, undefined);
});
