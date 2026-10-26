import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const transition of ['duplicate', 'new-loader', 'protected-same-loader']) {
  test(`ordering loader observation ${transition}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('loader');
    const session = await wire.attach('loader');
    const frame = { ...plainFrame('loader'), loaderId: 'synthetic-loader' };
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
    wire.release(held);
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
