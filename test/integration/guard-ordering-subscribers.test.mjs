import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const phase of ['initial', 'client-navigation', 'guard-navigation']) {
  test(`ordering runtime subscriber ${phase}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('subscriber');
    const session = await wire.attach('subscriber');
    await wire.send('Runtime.enable', {}, session);
    if (phase !== 'initial') {
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: phase === 'client-navigation' ? session : 'guard-subscriber',
        params: { frame: plainFrame('subscriber') },
      });
      await flush();
      await flush();
    }
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: {
        context: {
          id: 71,
          uniqueId: `synthetic-${phase}`,
          name: '',
          origin: new URL(ordinary).origin,
          auxData: { type: 'default', isDefault: true, frameId: 'subscriber' },
        },
      },
    });
    wire.emit({
      method: 'Runtime.consoleAPICalled',
      sessionId: session,
      params: {
        type: 'log',
        executionContextId: 71,
        args: [{ type: 'string', value: 'synthetic-subscriber' }],
        timestamp: 1,
      },
    });
    await flush();
    assert.deepEqual(
      wire.delivered.slice(mark).map((message) => message.method),
      ['Runtime.executionContextCreated', 'Runtime.consoleAPICalled']
    );
    assert.equal(
      wire.clients().some((message) => message.method === 'Runtime.evaluate'),
      false,
      'the subscriber needed no unrelated content command'
    );
  });
}
