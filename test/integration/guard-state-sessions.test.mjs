import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from(failed).toString('base64');
const refused = (a) => /^slicc: refused:/.test(a.error?.message ?? '');

for (const laterSession of ['other-target', 'browser']) {
  test(`state session identity ${laterSession}`, { timeout: 5000 }, async (t) => {
    const w = protocol(t);
    w.target('first');
    w.target('second');
    const first = await w.attach('first');
    const second = await w.attach('second');
    w.hold((m) => m.id === 701 && m.sessionId === first);
    w.request('Runtime.evaluate', { expression: '1' }, first, 701);
    await flush();
    assert.ok(w.held.find((m) => m.id === 701 && m.sessionId === first));
    const mark = w.sent.length;
    const method = laterSession === 'browser' ? 'Target.getTargets' : 'Runtime.evaluate';
    const s = laterSession === 'browser' ? undefined : second;
    const q = w.request(method, laterSession === 'browser' ? {} : { expression: '2' }, s, 701);
    const a = await q.answer;
    assert.deepEqual(
      {
        forwarded: w.clients(mark).some((m) => m.id === 701 && m.sessionId === s),
        success: a.error === undefined,
      },
      { forwarded: true, success: true },
      'CDP session-local IDs should not collide across flattened sessions'
    );
  });
}

test('state identity completion', { timeout: 5000 }, async (t) => {
  const w = protocol(t);
  w.target('first');
  w.target('second');
  const first = await w.attach('first');
  const second = await w.attach('second');
  assert.equal(
    (await w.request('Runtime.evaluate', { expression: '1' }, first, 701).answer).error,
    undefined
  );
  assert.equal(
    (await w.request('Runtime.evaluate', { expression: '2' }, second, 701).answer).error,
    undefined
  );
});

for (const recover of [false, true]) {
  test(`state identity collision recover=${recover}`, { timeout: 5000 }, async (t) => {
    const w = protocol(t);
    w.target('live');
    const s = await w.attach('live');
    w.hold((m) => m.id === 701);
    w.request('Page.captureScreenshot', {}, s, 701);
    await flush();
    const held = w.held.find((m) => m.id === 701);
    assert.ok(held);
    w.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-live',
      params: { frame: errorFrame('live') },
    });
    if (recover)
      w.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-live',
        params: { frame: plainFrame('live') },
      });
    const sent = w.sent.length;
    for (const method of ['Page.enable', 'Runtime.evaluate', 'Page.enable'])
      assert.ok(
        refused(
          await w.request(method, method === 'Runtime.evaluate' ? { expression: '1' } : {}, s, 701)
            .answer
        )
      );
    assert.equal(
      w.clients(sent).some((m) => m.id === 701),
      false
    );
    const mark = w.delivered.length;
    w.release(held, { result: { data: opaque } });
    await flush();
    assert.equal(JSON.stringify(w.delivered.slice(mark)).includes(opaque), false);
    w.hold(() => false);
    assert.equal(
      (await w.request('Page.enable', {}, s, 701).answer).error,
      undefined,
      'completion releases reservation'
    );
  });
}

for (const detached of ['direct', 'nested']) {
  test(`state identity detach ${detached}`, { timeout: 5000 }, async (t) => {
    const w = protocol(t);
    w.target('first');
    w.target('second');
    const first = await w.attach('first');
    const second = await w.attach('second');
    w.hold((m) => m.id === 701 && m.sessionId === first);
    w.request('Runtime.evaluate', { expression: '1' }, first, 701);
    await flush();
    w.emit({
      method: 'Target.detachedFromTarget',
      ...(detached === 'nested' ? { sessionId: second } : {}),
      params: { sessionId: first, targetId: 'first' },
    });
    await flush();
    const mark = w.sent.length;
    const a = await w.request('Runtime.evaluate', { expression: '2' }, second, 701).answer;
    assert.deepEqual(
      {
        forwarded: w.clients(mark).some((m) => m.id === 701 && m.sessionId === second),
        success: a.error === undefined,
      },
      { forwarded: true, success: true },
      "a dead session must not permanently reserve another session's request number"
    );
  });
}
