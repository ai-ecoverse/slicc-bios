import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { errorFrame, flush, protocol } from './guard-state-fixture.mjs';

for (const tree of [{ error: { code: -32000, message: 'no frame tree' } }, { result: {} }]) {
  test(`restored state a failed frame probe refuses a previously ordinary read ${Boolean(tree.error)}`, async (t) => {
    const wire = protocol(t);
    wire.target('restored-probe');
    const session = await wire.attach('restored-probe');
    wire.hold((message) => {
      if (message.method !== 'Page.getFrameTree') return false;
      queueMicrotask(() => wire.release(message, tree));
      return true;
    });
    const mark = wire.sent.length;
    const answer = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(wire.clients(mark).length, 0);
    assert.equal(
      wire.sent.slice(mark).filter((message) => message.method === 'Page.getFrameTree').length,
      3
    );
  });
}

for (const history of [
  { result: { currentIndex: 0 } },
  { result: { currentIndex: 0, entries: [] } },
  { result: { currentIndex: -1, entries: [{ id: 1, url: 'https://ordinary.invalid/page' }] } },
]) {
  test(`restored state an incomplete history probe refuses a read ${JSON.stringify(history.result)}`, async (t) => {
    const wire = protocol(t);
    wire.target('restored-history');
    const session = await wire.attach('restored-history');
    wire.hold((message) => {
      if (message.method !== 'Page.getNavigationHistory') return false;
      queueMicrotask(() => wire.release(message, history));
      return true;
    });
    const mark = wire.sent.length;
    const answer = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(wire.clients(mark).length, 0);
  });
}

for (const unreachableUrl of [undefined, '', 'not a URL', 'https://protected.invalid/private']) {
  test(`restored state an error discovered by a read probe stays closed ${String(unreachableUrl)}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('restored-error');
    const session = await wire.attach('restored-error');
    entry.tree.frame = { ...errorFrame('restored-error'), unreachableUrl };
    const mark = wire.sent.length;
    const answer = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(wire.clients(mark).length, 0);
    entry.tree.frame.url = 'https://ordinary.invalid/recovered';
    delete entry.tree.frame.unreachableUrl;
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error
        ?.message,
      PROTECTED
    );
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    await flush();
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
      undefined
    );
  });
}

test('restored state screenshot receipt checks the newly failed document', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('restored-pixels');
  const session = await wire.attach('restored-pixels');
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
  const pending = wire.request('Page.captureScreenshot', {}, session);
  await flush();
  entry.tree.frame = { ...errorFrame('restored-pixels'), unreachableUrl: undefined };
  wire.release(wire.held[0]);
  assert.equal((await pending.answer).error?.message, PROTECTED);
});
