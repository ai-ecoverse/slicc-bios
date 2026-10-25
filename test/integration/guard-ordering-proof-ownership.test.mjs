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

for (const failure of ['error', 'malformed', 'protected-error-tree']) {
  test(`failed attachment verification revokes existing transport ${failure}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('live');
    const original = await wire.attach('live');
    await wire.send('Network.enable', {}, original);
    await wire.send('Runtime.evaluate', { expression: '1' }, original);
    entry.info = { ...entry.info, url: 'chrome-error://chromewebdata/' };
    entry.tree = { frame: errorFrame('live') };
    const second = 'client-second';
    wire.sessions.set(second, 'live');
    if (failure === 'error') wire.privateFailure(true);
    if (failure === 'malformed')
      wire.hold(
        (message) => message.method === 'Page.getFrameTree' && message.sessionId === second
      );
    wire.emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: second, targetInfo: entry.info, waitingForDebugger: false },
    });
    await flush();
    if (failure === 'malformed') {
      const tree = wire.held.find((message) => message.method === 'Page.getFrameTree');
      assert.ok(tree);
      wire.release(tree, { result: {} });
    }
    await flush();
    assert.equal(
      wire.delivered.some(
        (message) =>
          message.method === 'Target.attachedToTarget' && message.params.sessionId === second
      ),
      false,
      'the new session is unconfirmed'
    );
    const mark = wire.delivered.length;
    const marker = `synthetic-unclassified-${failure}`;
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: original,
      params: {
        requestId: 'unknown-request',
        frameId: 'live',
        type: 'Other',
        documentURL: 'chrome-error://chromewebdata/',
        request: { url: ordinary, postData: marker },
      },
    });
    await flush();
    const published = wire.delivered.slice(mark);
    wire.privateFailure(false);
    wire.hold(() => false);
    entry.info = { ...entry.info, url: ordinary };
    entry.tree = { frame: plainFrame('live') };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-live',
      params: { frame: entry.tree.frame },
    });
    await flush();
    await flush();
    const recovery = await wire.send('Runtime.evaluate', { expression: '1' }, original);
    assert.equal(
      recovery.error,
      undefined,
      'fresh positive ordinary classification recovers the established client'
    );
    const ordinaryMark = wire.delivered.length;
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: original,
      params: {
        requestId: 'ordinary-request',
        frameId: 'live',
        request: { url: ordinary, postData: 'synthetic-current-ordinary' },
      },
    });
    await flush();
    assert.ok(
      JSON.stringify(wire.delivered.slice(ordinaryMark)).includes('synthetic-current-ordinary'),
      'current ordinary transport remains live'
    );
    assert.equal(
      JSON.stringify(published).includes(marker),
      false,
      'a failed/malformed/protected initial read revokes the old target-wide transport proof'
    );
  });
}

test('attachment metadata title must match the positively classified document', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('metadata');
  const original = await wire.attach('metadata');
  await wire.send('Runtime.evaluate', { expression: '1' }, original);
  entry.info = { ...entry.info, url: 'chrome-error://chromewebdata/', title: failed };
  entry.tree = { frame: plainFrame('metadata') };
  const second = 'client-second-metadata';
  wire.sessions.set(second, 'metadata');
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: second, targetInfo: entry.info, waitingForDebugger: false },
  });
  await flush();
  await flush();
  const events = wire.delivered.slice(mark);
  const current = await wire.send('Runtime.evaluate', { expression: '1' }, second);
  assert.equal(current.error, undefined, 'the positively ordinary document remains usable');
  assert.equal(
    JSON.stringify(events).includes(failed),
    false,
    'stale or mismatched error-target titles do not publish with a current ordinary attachment'
  );
});

for (const failure of ['error', 'malformed', 'protected']) {
  test(`older attachment ${failure} does not revoke newer independent proof`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('ownership');
    const original = await wire.attach('ownership');
    await wire.send('Network.enable', {}, original);
    const second = 'client-older-proof';
    wire.sessions.set(second, 'ownership');
    wire.hold((message) => message.method === 'Page.getFrameTree' && message.sessionId === second);
    wire.emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: second, targetInfo: entry.info, waitingForDebugger: false },
    });
    await flush();
    const old = wire.held.find((message) => message.sessionId === second);
    assert.ok(old);
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, original)).error,
      undefined
    );
    wire.release(
      old,
      failure === 'error'
        ? { error: { code: -32000, message: 'synthetic old failure' } }
        : failure === 'malformed'
          ? {}
          : { result: { frameTree: { frame: errorFrame('ownership') } } }
    );
    await flush();
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: original,
      params: {
        requestId: 'newer-proof-request',
        frameId: 'ownership',
        request: { url: ordinary, postData: 'synthetic-newer-proof' },
      },
    });
    await flush();
    assert.ok(JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-newer-proof'));
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, original)).error,
      undefined
    );
    assert.equal(
      wire.delivered.some(
        (event) => event.method === 'Target.attachedToTarget' && event.params.sessionId === second
      ),
      false
    );
  });
}
