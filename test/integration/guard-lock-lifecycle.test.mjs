import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from('synthetic-protected-marker').toString('base64');

for (const method of ['Page.enable', 'Runtime.evaluate']) {
  test(`a cancelled paint request retains its wire identity before ${method}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('lock-owner', 'page', plainFrame('lock-root'));
    const session = await wire.attach('lock-owner');
    wire.hold((message) => message.id === 901 && message.method === 'Page.captureScreenshot');
    const original = wire.request('Page.captureScreenshot', {}, session, 901);
    await flush();
    const held = wire.held.find((message) => message.id === original.id);
    assert.ok(held);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-lock-owner',
      params: { frame: { ...plainFrame('protected-child', 'lock-root'), url: failed } },
    });
    await flush();
    assert.equal(
      wire.delivered.find((answer) => answer.id === original.id && answer.sessionId === session)
        ?.error?.message,
      PROTECTED
    );
    assert.equal((await original.answer).error?.message, PROTECTED);
    const mark = wire.sent.length;
    assert.match(
      (
        await wire.request(
          method,
          method === 'Runtime.evaluate' ? { expression: '1' } : {},
          session,
          901
        ).answer
      ).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.deepEqual(wire.clients(mark), []);
    const delivered = wire.delivered.length;
    wire.release(held, { result: { data: opaque } });
    await flush();
    assert.equal(JSON.stringify(wire.delivered.slice(delivered)).includes(opaque), false);
    wire.hold(() => false);
    assert.equal((await wire.request('Page.enable', {}, session, 901).answer).error, undefined);
  });
}

for (const classification of ['protected', 'unresolved']) {
  test(`root replacement retains a ${classification} child until authoritative recovery`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('replacement-owner', 'page', plainFrame('old-root'));
    const session = await wire.attach('replacement-owner');
    wire.emit({
      method: 'Page.frameAttached',
      sessionId: 'guard-replacement-owner',
      params: { frameId: 'retained-child', parentFrameId: 'old-root' },
    });
    if (classification === 'protected')
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-replacement-owner',
        params: { frame: { ...plainFrame('retained-child', 'old-root'), url: failed } },
      });
    for (const root of ['replacement-root', 'final-root']) {
      entry.tree.frame = plainFrame(root);
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-replacement-owner',
        params: { frame: entry.tree.frame },
      });
      await flush();
      const mark = wire.sent.length;
      assert.equal(
        (await wire.send('Page.captureScreenshot', {}, session)).error?.message,
        PROTECTED
      );
      assert.deepEqual(wire.clients(mark), []);
      assert.equal(
        (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
        undefined
      );
    }
    if (classification === 'protected')
      wire.emit({
        method: 'Page.frameDetached',
        sessionId: 'guard-replacement-owner',
        params: { frameId: 'retained-child', reason: 'remove' },
      });
    else
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-replacement-owner',
        params: { frame: plainFrame('retained-child', 'final-root') },
      });
    await flush();
    const recovered = await wire.send('Page.captureScreenshot', {}, session);
    assert.equal(recovered.error, undefined);
    assert.ok(recovered.result.data);
  });
}

test('completion in one session does not cancel the same request number in another', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.target('first');
  wire.target('second');
  const first = await wire.attach('first');
  const second = await wire.attach('second');
  wire.hold((message) => message.id === 902 && message.sessionId === first);
  const a = wire.request('Runtime.evaluate', { expression: '1' }, first, 902);
  await flush();
  const held = wire.held.find((message) => message.id === 902 && message.sessionId === first);
  assert.ok(held);
  const b = wire.request('Runtime.evaluate', { expression: '2' }, second, 902);
  wire.release(held, { result: { result: { type: 'string', value: 'first-control' } } });
  const answers = await Promise.all([a.answer, b.answer]);
  assert.deepEqual(
    answers.map((answer) => answer.error),
    [undefined, undefined]
  );
  assert.deepEqual(
    answers.map((answer) => answer.result.result.value),
    ['first-control', 'synthetic-content']
  );
});
