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

for (const method of ['Target.targetInfoChanged', 'Target.targetCreated']) {
  test(`ordering unconfirmed metadata ${method}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('metadata', 'page', errorFrame('metadata'));
    entry.info.title = 'synthetic-pending';
    wire.privateFailure(true);
    wire.attached('metadata');
    await flush();
    entry.info.title = failed;
    if (method === 'Target.targetCreated')
      await wire.send('Target.setDiscoverTargets', { discover: true });
    const mark = wire.delivered.length;
    wire.emit({ method, params: { targetInfo: entry.info } });
    await flush();
    const initial = wire.delivered.slice(mark);
    wire.privateFailure(false);
    entry.info = { ...entry.info, url: ordinary, title: 'ordinary' };
    entry.tree = { frame: plainFrame('metadata') };
    const session = wire.attached('metadata');
    await flush();
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
      undefined
    );
    const recovered = wire.delivered.length;
    wire.emit({ method, params: { targetInfo: entry.info } });
    await flush();
    assert.ok(
      wire.delivered
        .slice(recovered)
        .some((event) => event.method === method && event.params.targetInfo.title === 'ordinary')
    );
    assert.equal(JSON.stringify(initial).includes(failed), false);
  });
}

for (const end of ['verified', 'destroyed', 'cleared', 'stale', 'protected', 'mismatch']) {
  test(`ordering current context ${end}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('context');
    const session = await wire.attach('context');
    await wire.send('Runtime.enable', {}, session);
    wire.hold(
      (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-context'
    );
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-context',
      params: { frame: plainFrame('context') },
    });
    await flush();
    const proof = wire.held.find((message) => message.method === 'Page.getFrameTree');
    assert.ok(proof);
    wire.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: {
        context: {
          id: 101,
          uniqueId: 'synthetic-current-context',
          origin: end === 'mismatch' ? 'https://other.invalid' : new URL(ordinary).origin,
          name: failed,
          auxData: { isDefault: true, type: 'default', frameId: 'context' },
        },
      },
    });
    wire.emit({
      method: 'Runtime.consoleAPICalled',
      sessionId: session,
      params: { type: 'log', args: [{ type: 'string', value: 'synthetic-unchecked-console' }] },
    });
    if (end === 'destroyed')
      wire.emit({
        method: 'Runtime.executionContextDestroyed',
        sessionId: session,
        params: { executionContextId: 101, executionContextUniqueId: 'synthetic-current-context' },
      });
    if (end === 'cleared')
      wire.emit({ method: 'Runtime.executionContextsCleared', sessionId: session, params: {} });
    if (end === 'stale')
      wire.emit({
        method: 'Page.frameAttached',
        sessionId: session,
        params: { frameId: 'uncertain-child', parentFrameId: 'context' },
      });
    if (end === 'protected') entry.tree = { frame: errorFrame('context') };
    await flush();
    wire.release(proof);
    await flush();
    await flush();
    const events = wire.delivered.slice(mark);
    const contexts = events.filter((event) => event.method === 'Runtime.executionContextCreated');
    assert.equal(contexts.length, end === 'verified' ? 1 : 0);
    if (end === 'verified') {
      assert.equal(contexts[0].params.context.id, 101);
      assert.equal(contexts[0].params.context.uniqueId, 'synthetic-current-context');
      assert.equal(contexts[0].params.context.name, '');
      assert.equal(contexts[0].params.context.origin, new URL(ordinary).origin);
    }
    assert.equal(JSON.stringify(events).includes(failed), false);
    assert.equal(JSON.stringify(events).includes('synthetic-unchecked-console'), false);
  });
}
