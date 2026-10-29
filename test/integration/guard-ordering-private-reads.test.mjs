import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, protocol } from './guard-ordering-fixture.mjs';

for (const failure of [
  { error: { code: -32000, message: 'synthetic private error' } },
  { result: {} },
]) {
  for (const [method, params, privateMethod] of [
    ['Page.navigateToHistoryEntry', { entryId: 1 }, 'Page.getNavigationHistory'],
    [
      'Network.searchInResponseBody',
      { requestId: 'ordinary-body', query: 'synthetic' },
      'Network.getResponseBody',
    ],
  ]) {
    test(`ordering private read ${method} ${failure.error ? 'error' : 'missing'}`, {
      timeout: 5000,
    }, async (t) => {
      const wire = protocol(t);
      wire.target('reads');
      const session = await wire.attach('reads');
      await wire.send('Runtime.evaluate', { expression: '1' }, session);
      wire.emit({
        method: 'Network.requestWillBeSent',
        sessionId: session,
        params: { requestId: 'ordinary-body', frameId: 'reads', request: { url: ordinary } },
      });
      await flush();
      wire.hold((message) => message.id >= 2 ** 30 && message.method === privateMethod);
      const mark = wire.sent.length;
      const pending = wire.send(method, params, session);
      await flush();
      wire.release(
        wire.held.find((message) => message.method === privateMethod),
        failure
      );
      const answer = await pending;
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
      assert.deepEqual(wire.clients(mark), []);
    });
  }
}
