import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const created = (id) => ({
  context: {
    id,
    origin: new URL(ordinary).origin,
    name: '',
    auxData: { isDefault: true, type: 'default', frameId: 'observed' },
  },
});
const consoleMessage = (executionContextId, marker) => ({
  type: 'log',
  executionContextId,
  args: [{ type: 'string', value: marker }],
});

for (const outcome of [
  'ordinary',
  'error',
  'missing',
  'stale',
  'destroyed',
  'replaced',
  'context-error',
  'context-missing',
  'context-mismatch',
]) {
  test(`ordering current context notification ${outcome}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('observed');
    const session = await wire.attach('observed');
    await wire.send('Runtime.enable', {}, session);
    wire.hold(
      (message) =>
        (message.sessionId === 'guard-observed' && message.method === 'Page.getFrameTree') ||
        (outcome.startsWith('context-') &&
          message.id >= 2 ** 30 &&
          message.method === 'Runtime.evaluate' &&
          message.params.expression === 'location.href')
    );
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: {
        frame: {
          id: 'observed',
          url: 'chrome-error://chromewebdata/',
          securityOrigin: '://',
          unreachableUrl: 'https://protected.invalid/controller/synthetic-context-transition',
        },
      },
    });
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-observed',
      params: { frame: plainFrame('observed') },
    });
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: created(71),
    });
    wire.emit({
      method: 'Runtime.consoleAPICalled',
      sessionId: session,
      params: consoleMessage(71, 'synthetic-pending-context-notice'),
    });
    wire.emit({
      method: 'Console.messageAdded',
      sessionId: session,
      params: { message: { text: 'synthetic-anonymous-pending-notice' } },
    });
    await flush();
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-pending-context-notice'),
      false
    );
    const proof = wire.held.find((message) => message.method === 'Page.getFrameTree');
    assert.ok(proof, 'the context waits on a guard-owned current-document read');
    if (outcome === 'stale')
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-observed',
        params: { frame: plainFrame('observed') },
      });
    if (outcome === 'destroyed')
      wire.emit({
        method: 'Runtime.executionContextDestroyed',
        sessionId: session,
        params: { executionContextId: 71 },
      });
    if (outcome === 'replaced') {
      wire.emit({
        method: 'Runtime.executionContextCreated',
        sessionId: session,
        params: created(71),
      });
      wire.emit({
        method: 'Runtime.consoleAPICalled',
        sessionId: session,
        params: consoleMessage(71, 'synthetic-replacement-context-notice'),
      });
    }
    wire.release(
      proof,
      outcome === 'error'
        ? { error: { code: -32000, message: 'synthetic failed context classification' } }
        : outcome === 'missing'
          ? { result: {} }
          : undefined
    );
    await flush();
    if (outcome.startsWith('context-')) {
      const scope = wire.held.find((message) => message.method === 'Runtime.evaluate');
      assert.ok(scope);
      wire.release(
        scope,
        outcome === 'context-error'
          ? { error: { code: -32000, message: 'synthetic context read error' } }
          : outcome === 'context-missing'
            ? { result: {} }
            : { result: { result: { value: 'chrome-error://chromewebdata/' } } }
      );
      await flush();
    }
    if (outcome === 'replaced') {
      for (const pending of [...wire.held]) wire.release(pending);
      await flush();
    }
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-pending-context-notice'),
      outcome === 'ordinary'
    );
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-anonymous-pending-notice'),
      false,
      'anonymous notices are never replayed into a later positive classification'
    );
    if (outcome === 'replaced')
      assert.equal(
        JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-replacement-context-notice'),
        true
      );
    wire.hold(() => false);
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
      undefined
    );
    if (['error', 'missing', 'stale'].includes(outcome) || outcome.startsWith('context-')) {
      const mark = wire.sent.length;
      const bad = await wire.send(
        'Runtime.evaluate',
        { expression: 'loadTimeData', contextId: 71 },
        session
      );
      assert.match(bad.error?.message ?? '', /^slicc: refused:/);
      assert.deepEqual(
        wire.clients(mark),
        [],
        'unpublished or retired contexts never gain command admission after unrelated ordinary recovery'
      );
    }
    wire.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: created(72),
    });
    wire.emit({
      method: 'Runtime.consoleAPICalled',
      sessionId: session,
      params: consoleMessage(72, 'synthetic-current-context-notice'),
    });
    await flush();
    assert.equal(JSON.stringify(wire.delivered).includes('synthetic-current-context-notice'), true);
  });
}

test('ordering cleared contexts retire pending notifications', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.target('observed');
  const session = await wire.attach('observed');
  await wire.send('Runtime.enable', {}, session);
  wire.hold(
    (message) => message.sessionId === 'guard-observed' && message.method === 'Page.getFrameTree'
  );
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: 'observed',
        url: 'chrome-error://chromewebdata/',
        securityOrigin: '://',
        unreachableUrl: 'https://protected.invalid/controller/synthetic-context-transition',
      },
    },
  });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-observed',
    params: { frame: plainFrame('observed') },
  });
  wire.emit({ method: 'Runtime.executionContextCreated', sessionId: session, params: created(71) });
  wire.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId: session,
    params: consoleMessage(71, 'synthetic-cleared-context-notice'),
  });
  await flush();
  wire.emit({ method: 'Runtime.executionContextsCleared', sessionId: session, params: {} });
  wire.release(wire.held.find((message) => message.method === 'Page.getFrameTree'));
  await flush();
  assert.equal(JSON.stringify(wire.delivered).includes('synthetic-cleared-context-notice'), false);
});
