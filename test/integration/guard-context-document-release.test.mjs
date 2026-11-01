import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

async function pendingRoot(t, retry = false) {
  const p = protocol(t);
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'old' });
  const session = await p.attach('root');
  assert.equal((await p.send('Runtime.enable', {}, session)).error, undefined);
  assert.equal(
    (await p.send('Fetch.enable', { patterns: [{ resourceType: 'Document' }] }, session)).error,
    undefined
  );
  root.tree.frame.loaderId = 'new';
  const context = {
    id: 31,
    uniqueId: 'pending-root-proof',
    name: '',
    origin: 'https://ordinary.invalid',
    auxData: { frameId: 'root', isDefault: true, type: 'default' },
  };
  let continued = false;
  let holdTrees = true;
  let firstProbe;
  let attempts = 0;
  p.hold((message) => {
    if (message.method === 'Fetch.continueRequest' && message.params.requestId === 'child-doc')
      continued = true;
    if (message.id < 2 ** 30) return false;
    if (message.method === 'Page.getFrameTree') return holdTrees;
    if (
      message.method !== 'Runtime.evaluate' ||
      message.params.uniqueContextId !== context.uniqueId
    )
      return false;
    attempts += 1;
    if (continued) return false;
    if (!firstProbe) {
      firstProbe = message;
      return true;
    }
    queueMicrotask(() =>
      p.release(message, {
        error: { code: -32000, message: "slicc: refused: target is on seven's origin" },
      })
    );
    return true;
  });
  p.emit({ sessionId: session, method: 'Page.frameNavigated', params: { frame: root.tree.frame } });
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'child', parentFrameId: 'root' },
  });
  p.emit({ sessionId: session, method: 'Runtime.executionContextCreated', params: { context } });
  await flush();
  if (retry) {
    p.release(firstProbe, {
      error: { code: -32000, message: "slicc: refused: target is on seven's origin" },
    });
    await flush();
  }
  holdTrees = false;
  for (const held of [...p.held]) if (held !== firstProbe) p.release(held);
  await flush();
  assert.ok(firstProbe);
  return {
    p,
    session,
    context,
    continued: () => continued,
    attempts: () => attempts,
    finish() {
      if (!retry) p.release(firstProbe);
    },
  };
}

function interception(session, overrides = {}) {
  return {
    method: 'Fetch.requestPaused',
    sessionId: session,
    params: {
      requestId: 'child-doc',
      networkId: 'child-net',
      frameId: 'child',
      resourceType: 'Document',
      request: { url: 'https://child.invalid/iframe', method: 'GET', headers: {} },
      ...overrides,
    },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('pending first root proof privately continues a client subframe Document and then proves the root', async (t) => {
  const row = await pendingRoot(t);
  row.p.emit(interception(row.session));
  await delay(30);
  assert.equal(row.continued(), true, 'child must continue before the root proof settles');
  assert.equal(row.attempts(), 1, 'the first probe is still pending, before any retry deadline');
  assert.equal(
    row.p.delivered.some(({ method }) => method === 'Fetch.requestPaused'),
    false,
    'client never sees the consumed child request'
  );
  assert.equal(
    row.p.delivered.some(({ params }) => params?.context?.uniqueId === row.context.uniqueId),
    false,
    'no client context overtakes the proof'
  );
  row.finish();
  assert.equal((await row.p.send('Runtime.enable', {}, row.session)).error, undefined);
  assert.equal(
    (await row.p.send('Runtime.evaluate', { expression: 'location.href' }, row.session)).error,
    undefined
  );
  assert.equal(row.attempts(), 1);
  assert.equal(
    row.p.delivered.some(({ method }) => method === 'Fetch.requestPaused'),
    false
  );
});

test('pending timer retry continues the child privately and the same root context recovers', async (t) => {
  const row = await pendingRoot(t, true);
  row.p.emit(interception(row.session));
  await delay(30);
  assert.equal(row.continued(), true);
  assert.equal(
    row.p.delivered.some(({ method }) => method === 'Fetch.requestPaused'),
    false
  );
  assert.equal((await row.p.send('Runtime.enable', {}, row.session)).error, undefined);
  assert.equal(
    (await row.p.send('Runtime.evaluate', { expression: 'location.href' }, row.session)).error,
    undefined
  );
  assert.ok(row.attempts() >= 2);
});

test('protected and unknown subframe Documents fail privately while a root proof is pending', async (t) => {
  for (const url of ['https://protected.invalid/child', '', 'about:blank', 'not a URL']) {
    const row = await pendingRoot(t);
    row.p.emit(interception(row.session, { request: { url } }));
    await delay(30);
    assert.equal(row.continued(), false);
    assert.ok(
      row.p.sent.some(
        ({ method, params, sessionId }) =>
          method === 'Fetch.failRequest' &&
          params.requestId === 'child-doc' &&
          sessionId === row.session
      ),
      `must fail ${url}`
    );
    assert.equal(
      row.p.delivered.some(({ method }) => method === 'Fetch.requestPaused'),
      false
    );
  }
});

test('root Documents, other resources, response pauses and other client events keep their queue order', async (t) => {
  const row = await pendingRoot(t);
  for (const overrides of [
    { frameId: 'root', requestId: 'root-doc' },
    { resourceType: 'Script', requestId: 'script' },
    { responseStatusCode: 200, requestId: 'response' },
    { frameId: 'unknown-frame', requestId: 'unplaced' },
  ])
    row.p.emit(interception(row.session, overrides));
  row.p.emit({ method: 'Page.loadEventFired', sessionId: row.session, params: { timestamp: 1 } });
  await delay(30);
  assert.equal(
    row.p.sent.some(({ method }) =>
      ['Fetch.continueRequest', 'Fetch.failRequest'].includes(method)
    ),
    false
  );
  assert.equal(
    row.p.delivered.some(({ method }) =>
      ['Fetch.requestPaused', 'Page.loadEventFired'].includes(method)
    ),
    false
  );
});
