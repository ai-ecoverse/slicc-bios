import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const outcome of ['verified', 'error', 'missing', 'mismatch']) {
  test(`ordering private priming preserves ordinary frame command admission ${outcome}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('primed-parent');
    const session = await wire.attach('primed-parent');
    const frame = { ...plainFrame('primed-child', 'primed-parent'), url: `${ordinary}/inner` };
    entry.tree.childFrames = [{ frame }];
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-primed-parent',
      params: { frame },
    });
    wire.hold(
      (message) =>
        (message.id >= 2 ** 30 && message.method === 'Runtime.enable') ||
        (message.id >= 2 ** 30 &&
          message.method === 'Runtime.evaluate' &&
          message.params.expression === 'location.href') ||
        (message.id < 2 ** 30 && message.method === 'Page.createIsolatedWorld')
    );
    const world = wire.send(
      'Page.createIsolatedWorld',
      { frameId: frame.id, worldName: 'synthetic-ordinary-world' },
      session
    );
    await flush();
    const prime = wire.held.find((message) => message.method === 'Runtime.enable');
    assert.ok(prime, 'the guard privately enables Runtime to inspect utility worlds');
    wire.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: {
        context: {
          id: 701,
          uniqueId: 'synthetic-primed-frame',
          origin: new URL(ordinary).origin,
          name: 'synthetic-ordinary-world',
          auxData: { frameId: frame.id, type: 'isolated', isDefault: false },
        },
      },
    });
    wire.release(prime);
    await flush();
    const realm = wire.held.find((message) => message.method === 'Runtime.evaluate');
    assert.ok(realm, 'the guard independently checks the actual new realm');
    wire.release(
      realm,
      outcome === 'error'
        ? { error: { code: -32000, message: 'synthetic realm read failure' } }
        : outcome === 'missing'
          ? { result: {} }
          : {
              result: {
                result: {
                  type: 'string',
                  value: outcome === 'mismatch' ? 'chrome-error://chromewebdata/' : frame.url,
                },
              },
            }
    );
    await flush();
    const creation = wire.held.find((message) => message.method === 'Page.createIsolatedWorld');
    if (outcome === 'verified') {
      assert.ok(creation);
      wire.release(creation, { result: { executionContextId: 701 } });
      assert.equal((await world).error, undefined);
    } else {
      assert.equal(
        creation,
        undefined,
        'a failed private realm check forwards no frame-world creation'
      );
      const answer = await world;
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
    }
    assert.equal(
      wire.delivered.some((message) => message.method === 'Runtime.executionContextCreated'),
      false,
      'private priming does not subscribe the caller to Runtime events'
    );
    wire.hold(() => false);
    const mark = wire.sent.length;
    const read = await wire.send(
      'Runtime.evaluate',
      { contextId: 701, expression: 'document.title', returnByValue: true },
      session
    );
    if (outcome === 'verified') {
      assert.equal(
        read.error,
        undefined,
        'a positively verified utility world is usable without a public Runtime subscription'
      );
      assert.equal(
        wire.clients(mark).filter((message) => message.method === 'Runtime.evaluate').length,
        1
      );
    } else {
      assert.match(read.error?.message ?? '', /^slicc: refused:/);
      assert.equal(read.result, undefined);
      assert.deepEqual(wire.clients(mark), []);
    }
  });
}
