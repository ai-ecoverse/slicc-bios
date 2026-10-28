import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-ordering-fixture.mjs';

async function created(t, initial, commit = true) {
  const wire = protocol(t);
  const id = 'created-startup';
  const entry = wire.target(id, 'page', {
    id,
    url: 'about:blank',
    securityOrigin: '://',
    loaderId: 'initial-blank',
  });
  let complete;
  let committed = false;
  const settled = new Promise((resolve) => {
    complete = resolve;
  });
  let timer;
  t.after(() => clearTimeout(timer));
  wire.hold((message) => {
    if (message.method === 'Target.createTarget') {
      queueMicrotask(() => wire.release(message, { result: { targetId: id } }));
      return true;
    }
    if (message.method === 'Page.navigate' && message.sessionId === `guard-${id}`) {
      queueMicrotask(() => {
        entry.info.url = ordinary;
        entry.tree = initial(id);
        wire.release(message, { result: { frameId: id, loaderId: 'ordinary-document' } });
        if (!commit) return complete();
        timer = setTimeout(() => {
          entry.tree.frame = { ...plainFrame(id), loaderId: 'ordinary-document' };
          for (const child of entry.tree.childFrames ?? [])
            child.frame = { ...plainFrame(child.frame.id, id), loaderId: 'ordinary-child' };
          wire.emit({
            method: 'Page.frameNavigated',
            sessionId: `guard-${id}`,
            params: { frame: entry.tree.frame },
          });
          wire.emit({
            method: 'Page.frameStoppedLoading',
            sessionId: `guard-${id}`,
            params: { frameId: id },
          });
          committed = true;
          complete();
        }, 200);
      });
      return true;
    }
    return false;
  });
  const creation = await wire.send('Target.createTarget', { url: ordinary });
  assert.equal(creation.error, undefined);
  assert.equal(creation.result.targetId, id);
  return { wire, id, entry, settled, committed: () => committed };
}

for (const loader of [false, true]) {
  for (const children of [false, true]) {
    test(`residual created ordinary empty-origin root waits loader ${loader} children ${children}`, {
      timeout: 5000,
    }, async (t) => {
      const row = await created(t, (id) => ({
        frame: {
          ...plainFrame(id),
          securityOrigin: '',
          ...(loader ? { loaderId: 'loading-root' } : {}),
        },
        ...(children
          ? {
              childFrames: [
                { frame: { ...plainFrame('created-child', id), loaderId: 'ordinary-child' } },
              ],
            }
          : {}),
      }));
      const attached = await row.wire.send('Target.attachToTarget', {
        targetId: row.id,
        flatten: true,
      });
      assert.equal(attached.error, undefined);
      assert.equal(row.committed(), true);
      const session = attached.result.sessionId;
      const tree = await row.wire.send('Page.getFrameTree', {}, session);
      assert.equal(tree.error, undefined);
      assert.equal(tree.result.frameTree.frame.securityOrigin, new URL(ordinary).origin);
      assert.equal(tree.result.frameTree.frame.loaderId, 'ordinary-document');
      assert.equal(
        (await row.wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
        undefined
      );
      assert.equal((await row.wire.send('DOM.getDocument', {}, session)).error, undefined);
      assert.equal((await row.wire.send('Page.captureScreenshot', {}, session)).error, undefined);
    });
  }
}

for (const state of [
  'never settled',
  'protected URL',
  'protected origin',
  'error URL',
  'opaque URL',
  'child empty origin',
]) {
  test(`residual created empty-origin evidence refuses ${state}`, { timeout: 5000 }, async (t) => {
    const row = await created(
      t,
      (id) => {
        const frame = { ...plainFrame(id), securityOrigin: '', loaderId: 'loading-root' };
        if (state === 'protected URL') frame.url = `${protectedOrigin}/page`;
        if (state === 'protected origin') frame.securityOrigin = protectedOrigin;
        if (state === 'error URL') Object.assign(frame, errorFrame(id), { securityOrigin: '' });
        if (state === 'opaque URL') frame.url = 'data:text/html,ordinary';
        if (state === 'child empty origin')
          return {
            frame: { ...plainFrame(id), loaderId: 'ordinary-root' },
            childFrames: [
              { frame: { ...plainFrame('empty-origin-child', id), securityOrigin: '' } },
            ],
          };
        return { frame };
      },
      state !== 'never settled'
    );
    const attached = await row.wire.send('Target.attachToTarget', {
      targetId: row.id,
      flatten: true,
    });
    assert.match(attached.error?.message ?? '', /^slicc: refused:/);
    assert.equal(attached.result, undefined);
    assert.equal(row.committed(), false);
    const attempts = row.wire.sent.filter(
      (message) =>
        message.method === 'Page.getFrameTree' && message.sessionId === `client-${row.id}`
    ).length;
    assert.ok(attempts >= 1 && attempts <= (state === 'never settled' ? 25 : 1));
    await row.settled;
  });
}
