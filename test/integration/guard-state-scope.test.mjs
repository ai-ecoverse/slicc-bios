import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from(failed).toString('base64');
const refused = (a) => /^slicc: refused:/.test(a.error?.message ?? '');

for (const order of ['ancestor-first', 'leaf-first']) {
  for (const recovery of ['remove', 'ordinary-commit']) {
    test(`state linked scope ${order}/${recovery}`, { timeout: 5000 }, async (t) => {
      const w = protocol(t);
      w.target('parent', 'page', plainFrame('parent-root'));
      w.target('child', 'iframe', plainFrame('child-root'));
      const s = await w.attach('parent');
      await w.attach('child');
      w.hold((m) => m.id < 2 ** 30 && m.method === 'Page.printToPDF');
      const q = w.request('Page.printToPDF', {}, s);
      await flush();
      const held = w.held.find((m) => m.id === q.id);
      assert.ok(held);
      w.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-child',
        params: { frame: errorFrame('child-root') },
      });
      const ancestor = {
        method: 'Page.frameAttached',
        sessionId: 'guard-parent',
        params: { frameId: 'middle', parentFrameId: 'parent-root' },
      };
      const leaf = {
        method: 'Page.frameAttached',
        sessionId: 'guard-parent',
        params: { frameId: 'child-root', parentFrameId: 'middle' },
      };
      for (const e of order === 'ancestor-first' ? [ancestor, leaf] : [leaf, ancestor]) w.emit(e);
      await flush();
      assert.ok(refused(await w.send('Page.printToPDF', {}, s)));
      if (recovery === 'remove')
        w.emit({
          method: 'Page.frameDetached',
          sessionId: 'guard-parent',
          params: { frameId: 'middle', reason: 'remove' },
        });
      else
        w.emit({
          method: 'Page.frameNavigated',
          sessionId: 'guard-child',
          params: { frame: plainFrame('child-root') },
        });
      w.release(held, { result: { data: opaque } });
      const a = await q.answer;
      assert.ok(refused(a));
      assert.equal(JSON.stringify(a).includes(opaque), false);
      w.hold(() => false);
      assert.equal(
        (await w.send('Page.printToPDF', {}, s)).error,
        undefined,
        'new safe parent reads recover'
      );
    });
  }
}

for (const detach of ['direct', 'nested']) {
  for (const sameTurn of [false, true]) {
    test(`state detached late ${detach}/sameTurn=${sameTurn}`, { timeout: 5000 }, async (t) => {
      const w = protocol(t);
      w.target('live');
      w.target('outer');
      const s = await w.attach('live');
      const outer = await w.attach('outer');
      w.hold((m) => m.id < 2 ** 30 && m.method === 'Page.captureScreenshot');
      const q = w.request('Page.captureScreenshot', {}, s);
      await flush();
      const held = w.held.find((m) => m.id === q.id);
      assert.ok(held);
      w.emit({
        method: 'Target.detachedFromTarget',
        ...(detach === 'nested' ? { sessionId: outer } : {}),
        params: { sessionId: s, targetId: 'live' },
      });
      if (!sameTurn) await flush();
      w.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-live',
        params: { frame: errorFrame('live') },
      });
      w.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-live',
        params: { frame: plainFrame('live') },
      });
      w.release(held, { result: { data: opaque } });
      const a = await q.answer;
      assert.ok(refused(a), 'detach revokes pending renderer content independent of current root');
      assert.equal(JSON.stringify(a).includes(opaque), false);
      w.hold(() => false);
      assert.equal((await w.send('Runtime.evaluate', { expression: '1' }, outer)).error, undefined);
    });
  }
}
