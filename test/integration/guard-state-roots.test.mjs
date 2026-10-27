import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from(failed).toString('base64');
const refused = (a) => /^slicc: refused:/.test(a.error?.message ?? '');

for (const method of ['Page.captureScreenshot', 'Page.printToPDF', 'DOMSnapshot.captureSnapshot']) {
  test(`state authoritative renderer ${method}`, { timeout: 5000 }, async (t) => {
    const w = protocol(t);
    w.target('parent', 'page', plainFrame('parent-root'));
    await w.attach('parent');
    w.target('oopif', 'iframe', plainFrame('oopif-root', 'parent-root'));
    const s = await w.attach('oopif');
    w.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-oopif',
      params: { frame: errorFrame('unsafe-inner', 'oopif-root') },
    });
    await flush();
    assert.ok(
      refused(
        await w.send(
          method,
          method === 'DOMSnapshot.captureSnapshot' ? { computedStyles: [] } : {},
          s
        )
      ),
      'negative descendant is known before sibling commit'
    );
    w.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-oopif',
      params: { frame: plainFrame('safe-sibling', 'oopif-root') },
    });
    await flush();
    w.hold((m) => m.id < 2 ** 30 && m.method === method);
    const mark = w.sent.length;
    const q = w.request(
      method,
      method === 'DOMSnapshot.captureSnapshot' ? { computedStyles: [] } : {},
      s
    );
    await flush();
    const held = w.held.find((m) => m.id === q.id);
    if (held)
      w.release(held, {
        result:
          method === 'DOMSnapshot.captureSnapshot'
            ? { documents: [], strings: [opaque] }
            : { data: opaque },
      });
    const a = await q.answer;
    assert.deepEqual(
      {
        forwarded: w.clients(mark).some((m) => m.id === q.id),
        refused: refused(a),
        exposed: JSON.stringify(a).includes(opaque),
      },
      { forwarded: false, refused: true, exposed: false },
      'a sibling commit cannot replace the target root or remove its unsafe descendant'
    );
  });
}

test('state authoritative publication', { timeout: 5000 }, async (t) => {
  const w = protocol(t);
  w.target('oopif', 'iframe', plainFrame('oopif-root', 'parent-root'));
  const s = await w.attach('oopif');
  await w.send('Page.enable', {}, s);
  await w.send('Page.startScreencast', {}, s);
  w.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-oopif',
    params: { frame: errorFrame('unsafe-inner', 'oopif-root') },
  });
  w.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-oopif',
    params: { frame: plainFrame('safe-sibling', 'oopif-root') },
  });
  await flush();
  const mark = w.delivered.length;
  w.emit({
    method: 'Page.screencastFrame',
    sessionId: s,
    params: {
      data: opaque,
      sessionId: 17,
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 800,
        deviceHeight: 600,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    },
  });
  await flush();
  assert.equal(JSON.stringify(w.delivered.slice(mark)).includes(opaque), false);
});

for (const commitSession of ['guard-oopif', 'client-oopif']) {
  test(`state authoritative ordinary ${commitSession}`, { timeout: 5000 }, async (t) => {
    const w = protocol(t);
    w.target('oopif', 'iframe', plainFrame('oopif-root', 'parent-root'));
    const s = await w.attach('oopif');
    w.emit({
      method: 'Page.frameNavigated',
      sessionId: commitSession,
      params: { frame: plainFrame('safe-inner', 'oopif-root') },
    });
    w.emit({
      method: 'Page.frameDetached',
      sessionId: commitSession,
      params: { frameId: 'safe-inner', reason: 'remove' },
    });
    await flush();
    assert.equal((await w.send('Page.captureScreenshot', {}, s)).error, undefined);
  });
}
