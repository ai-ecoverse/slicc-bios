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

for (const mode of [
  'console',
  'exception',
  'anonymous',
  'destroyed',
  'cleared',
  'replaced',
  'stale',
  'protected',
  'mismatch',
  'failed',
]) {
  test(`ordering receipt-owned default context ${mode}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('admission');
    const session = await wire.attach('admission');
    await wire.send('Runtime.enable', {}, session);
    wire.hold(
      (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-admission'
    );
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-admission',
      params: { frame: plainFrame('admission') },
    });
    await flush();
    const check = wire.held.find((message) => message.method === 'Page.getFrameTree');
    const context = {
      id: 101,
      uniqueId: 'synthetic-admission',
      name: failed,
      origin: mode === 'mismatch' ? 'https://other.invalid' : new URL(ordinary).origin,
      auxData: { isDefault: true, type: 'default', frameId: 'admission' },
    };
    wire.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: { context },
    });
    const mark = wire.delivered.length;
    const method = mode === 'exception' ? 'Runtime.exceptionThrown' : 'Runtime.consoleAPICalled';
    const marker = 'synthetic-receipt-owned-content';
    wire.emit({
      method,
      sessionId: session,
      params:
        method === 'Runtime.exceptionThrown'
          ? { exceptionDetails: { executionContextId: 101, text: marker } }
          : {
              type: 'log',
              ...(mode === 'anonymous' ? {} : { executionContextId: 101 }),
              args: [
                { type: 'string', value: marker },
                { type: 'string', value: failed },
              ],
            },
    });
    if (mode === 'destroyed')
      wire.emit({
        method: 'Runtime.executionContextDestroyed',
        sessionId: session,
        params: { executionContextId: 101 },
      });
    if (mode === 'cleared')
      wire.emit({ method: 'Runtime.executionContextsCleared', sessionId: session, params: {} });
    if (mode === 'replaced')
      wire.emit({
        method: 'Runtime.executionContextCreated',
        sessionId: session,
        params: { context: { ...context, uniqueId: 'synthetic-replaced' } },
      });
    if (mode === 'stale')
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-admission',
        params: { frame: plainFrame('admission') },
      });
    if (mode === 'protected') entry.tree = { frame: errorFrame('admission') };
    await flush();
    assert.equal(
      wire.delivered.slice(mark).some((event) => event.method === method),
      false,
      'no content publishes while the receipt-owned proof is pending'
    );
    wire.release(
      check,
      mode === 'failed'
        ? { error: { code: -32000, message: 'synthetic failed receipt check' } }
        : undefined
    );
    await flush();
    await flush();
    const events = wire.delivered.slice(mark);
    assert.equal(
      events.some((event) => event.method === method && JSON.stringify(event).includes(marker)),
      ['console', 'exception'].includes(mode)
    );
    assert.equal(JSON.stringify(events).includes(failed), false);
  });
}
