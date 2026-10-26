import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const transition of [
  'duplicate',
  'new-loader',
  'protected-same-loader',
  'unknown-loader',
  'fresh-proof-mismatch',
  'fresh-proof-error',
]) {
  test(`ordering loader observation ${transition}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('loader');
    const session = await wire.attach('loader');
    const frame = { ...plainFrame('loader'), loaderId: 'synthetic-loader' };
    entry.tree = { frame: transition === 'unknown-loader' ? plainFrame('loader') : frame };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame, type: 'Navigation' },
    });
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
      undefined
    );
    wire.hold((message) => message.method === 'Runtime.evaluate' && message.id < 2 ** 30);
    const read = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
    await flush();
    const held = wire.held.find((message) => message.id === read.id);
    const next =
      transition === 'new-loader'
        ? { ...frame, loaderId: 'synthetic-next-loader' }
        : transition === 'protected-same-loader'
          ? { ...errorFrame('loader'), loaderId: 'synthetic-loader' }
          : frame;
    entry.tree = { frame: next };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-loader',
      params: { frame: next, type: 'Navigation' },
    });
    await flush();
    wire.hold(
      (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-loader'
    );
    wire.release(held);
    if (transition === 'duplicate' || transition.startsWith('fresh-proof')) {
      await flush();
      const proof = wire.held.find((message) => message.method === 'Page.getFrameTree');
      assert.ok(proof, 'a duplicate requires one more bounded private check');
      assert.equal(
        wire.delivered.some((message) => message.id === read.id),
        false,
        'the original reply stays withheld until positive revalidation'
      );
      if (transition === 'fresh-proof-mismatch')
        entry.tree = { frame: { ...frame, url: 'https://other.invalid/' } };
      wire.release(
        proof,
        transition === 'fresh-proof-error'
          ? { error: { code: -32000, message: 'synthetic failed revalidation' } }
          : undefined
      );
    }
    const answer = await read.answer;
    if (transition === 'duplicate')
      assert.equal(
        answer.error,
        undefined,
        'two sessions observing the same committed loader do not replace the document twice'
      );
    else assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  });
}
