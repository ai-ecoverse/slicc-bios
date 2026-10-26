import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import { errorFrame, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const kind of ['parent', 'iframe']) {
  for (const outcome of [
    'verified',
    'navigate-error',
    'missing-ack',
    'unchanged',
    'missing-tree',
    'stale',
  ]) {
    test(`ordering opaque error cleanup ${kind} ${outcome}`, { timeout: 5000 }, async (t) => {
      const wire = protocol(t);
      let entry;
      let session;
      let pending;
      const child = errorFrame('cleanup-child', kind === 'parent' ? 'cleanup-parent' : undefined);
      if (kind === 'parent') {
        entry = wire.target('cleanup-parent');
        session = await wire.attach('cleanup-parent');
        await wire.send('Runtime.evaluate', { expression: '1' }, session);
        entry.tree.childFrames = [{ frame: child }];
      } else {
        entry = wire.target('cleanup-child', 'iframe', child);
        entry.info.url = 'https://ordinary.invalid/unreachable';
      }
      wire.hold((message) => message.id >= 2 ** 30 && message.method === 'Page.navigate');
      if (kind === 'parent')
        wire.emit({
          method: 'Page.frameNavigated',
          sessionId: 'guard-cleanup-parent',
          params: { frame: child },
        });
      else
        pending = wire.request('Target.attachToTarget', {
          targetId: 'cleanup-child',
          flatten: true,
        });
      await flush();
      const navigate = wire.held.find((message) => message.method === 'Page.navigate');
      assert.ok(
        navigate,
        'the guard independently reads the opaque error and requests its own fixed blank document'
      );
      assert.equal(navigate.params.url, BLANKED);
      assert.equal(navigate.params.frameId, child.id);
      const mark = wire.sent.length;
      const read =
        kind === 'parent'
          ? wire.send('Runtime.evaluate', { expression: 'document.title' }, session)
          : undefined;
      await flush();
      if (kind === 'parent') assert.deepEqual(wire.clients(mark), []);
      if (!['navigate-error', 'missing-ack', 'unchanged'].includes(outcome)) {
        const blank = {
          ...plainFrame(child.id, child.parentId),
          url: BLANKED,
          securityOrigin: '://',
        };
        if (kind === 'parent') entry.tree.childFrames = [{ frame: blank }];
        else entry.tree = { frame: blank };
      }
      if (outcome === 'missing-tree' || outcome === 'stale')
        wire.hold((message) => message.id >= 2 ** 30 && message.method === 'Page.getFrameTree');
      else wire.hold(() => false);
      for (const operation of [...wire.held].filter(
        (message) => message.method === 'Page.navigate'
      ))
        wire.release(
          operation,
          outcome === 'navigate-error'
            ? { error: { code: -32000, message: 'synthetic cleanup failed' } }
            : outcome === 'missing-ack'
              ? { result: {} }
              : { result: { frameId: child.id } }
        );
      await flush();
      if (outcome === 'missing-tree' || outcome === 'stale') {
        for (const tree of [...wire.held]) {
          if (outcome === 'stale')
            wire.emit({
              method: 'Page.frameNavigated',
              sessionId: kind === 'parent' ? 'guard-cleanup-parent' : 'guard-cleanup-child',
              params: { frame: kind === 'parent' ? entry.tree.frame : entry.tree.frame },
            });
          wire.release(tree, outcome === 'missing-tree' ? { result: {} } : undefined);
        }
        await flush();
      }
      if (kind === 'parent') assert.match((await read).error?.message ?? '', /^slicc: refused:/);
      if (kind === 'iframe') {
        const answer = await pending.answer;
        if (outcome === 'verified') {
          assert.equal(answer.error, undefined);
          session = answer.result.sessionId;
        } else assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      }
      if (outcome === 'verified') {
        const answer = await wire.send('Page.captureScreenshot', {}, session);
        assert.equal(
          answer.error,
          undefined,
          'content is enabled only for the independently verified harmless replacement'
        );
        assert.equal(answer.result?.data, 'c3ludGhldGlj');
      } else if (kind === 'parent') {
        wire.hold(() => false);
        if (outcome === 'missing-tree' || outcome === 'stale')
          entry.tree.childFrames = [{ frame: child }];
        const answer = await wire.send('Page.captureScreenshot', {}, session);
        assert.match(answer.error?.message ?? '', /^slicc: refused:/);
        assert.equal(answer.result, undefined);
      }
    });
  }
}

test('ordering loaded protected children are never treated as cleanup candidates', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('loaded-parent');
  const session = await wire.attach('loaded-parent');
  entry.tree.childFrames = [
    {
      frame: {
        id: 'loaded-child',
        parentId: 'loaded-parent',
        url: 'https://protected.invalid/live',
        securityOrigin: 'https://protected.invalid',
      },
    },
  ];
  const answer = await wire.send('Page.captureScreenshot', {}, session);
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(
    wire.sent.some((message) => message.method === 'Page.navigate'),
    false
  );
});
