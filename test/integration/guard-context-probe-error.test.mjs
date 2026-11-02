import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, ordinary, protocol } from './guard-ordering-fixture.mjs';

for (const message of [
  'synthetic realm uncertainty',
  'slicc: refused: unknown private probe failure',
  "page quoted slicc: refused: target is on seven's origin",
  "slicc: refused: target is on seven's origin suffix",
])
  test(`a non-seal private probe error settles before fresh-tree recovery at 150 ms: ${message}`, async (t) => {
    const p = protocol(t);
    p.target('owner');
    const session = await p.attach('owner');
    await p.send('Runtime.enable', {}, session);
    await p.send('Runtime.evaluate', { expression: 'document.title' }, session);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    p.hold(
      (command) =>
        command.id >= 2 ** 30 &&
        command.method === 'Runtime.evaluate' &&
        command.params.expression === 'location.href'
    );
    p.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: {
        context: {
          id: 93,
          uniqueId: 'generic-error-proof',
          origin: new URL(ordinary).origin,
          name: '',
          auxData: { frameId: 'owner', isDefault: true, type: 'default' },
        },
      },
    });
    await flush();
    const held = p.held.find((command) => command.method === 'Runtime.evaluate');
    assert.ok(held);
    p.release(held, { error: { code: -32000, message } });
    await flush();
    p.privateFailure(true);
    const negative = p.send('Runtime.evaluate', { expression: 'document.title' }, session);
    await flush();
    t.mock.timers.tick(100);
    await flush();
    p.privateFailure(false);
    p.hold(() => false);
    t.mock.timers.tick(50);
    assert.equal(Date.now(), 150);
    const recovery = p.send('Runtime.evaluate', { expression: 'document.title' }, session);
    await flush();
    t.mock.timers.tick(850);
    await flush();
    assert.match((await negative).error?.message ?? '', /^slicc: refused:/);
    assert.equal((await recovery).error, undefined);
    assert.equal(
      p.sent.filter(
        (command) =>
          command.id >= 2 ** 30 &&
          command.method === 'Runtime.evaluate' &&
          command.params.uniqueContextId === 'generic-error-proof'
      ).length,
      1
    );
  });
