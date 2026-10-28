import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordinary, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const setup = (t, id) => {
  const wire = protocol(t);
  const entry = wire.target(id);
  entry.tree.frame.loaderId = 'settled-parent';
  entry.tree.childFrames = ['blank-editor', 'srcdoc-editor'].map((child) => ({
    frame: { ...plainFrame(child, id), url: '', securityOrigin: new URL(ordinary).origin },
  }));
  return { wire, entry };
};

for (const delay of [200, 1200]) {
  test(`residual a settled ordinary parent's editor children commit after ${delay} ms`, {
    timeout: 6000,
  }, async (t) => {
    const { wire, entry } = setup(t, 'loading-editor-parent');
    const timer = setTimeout(() => {
      entry.tree.childFrames.forEach((child, index) => {
        child.frame.url = index === 0 ? 'about:blank' : 'about:srcdoc';
        child.frame.loaderId = 'settled-editor';
      });
    }, delay);
    t.after(() => clearTimeout(timer));
    const started = Date.now();
    const answer = await wire.send('Target.attachToTarget', {
      targetId: entry.info.targetId,
      flatten: true,
    });
    assert.equal(answer.error, undefined);
    assert.ok(Date.now() - started >= delay);
    const tree = await wire.send('Page.getFrameTree', {}, answer.result.sessionId);
    assert.equal(tree.error, undefined);
    assert.deepEqual(
      tree.result.frameTree.childFrames.map((child) => child.frame.url),
      ['about:blank', 'about:srcdoc']
    );
    assert.equal(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: 'document.title' },
          answer.result.sessionId
        )
      ).error,
      undefined
    );
  });
}

for (const variant of ['still loading', 'parent without loader', 'protected child']) {
  test(`residual editor children fail closed when ${variant}`, {
    timeout: variant === 'still loading' ? 9000 : 6000,
  }, async (t) => {
    const { wire, entry } = setup(t, `editor-${variant}`);
    if (variant === 'parent without loader') delete entry.tree.frame.loaderId;
    if (variant === 'protected child')
      entry.tree.childFrames[0].frame.securityOrigin = protectedOrigin;
    const started = Date.now();
    const answer = await wire.send('Target.attachToTarget', {
      targetId: entry.info.targetId,
      flatten: true,
    });
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.ok(Date.now() - started < (variant === 'still loading' ? 4500 : 2500));
    const attempts = wire.sent.filter(
      (message) =>
        message.method === 'Page.getFrameTree' &&
        message.sessionId === `client-${entry.info.targetId}`
    ).length;
    assert.ok(attempts >= 1 && attempts <= (variant === 'still loading' ? 75 : 25));
    const before = wire.sent.length;
    const readStarted = Date.now();
    assert.match(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: 'document.title' },
          `client-${entry.info.targetId}`
        )
      ).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.ok(Date.now() - readStarted < (variant === 'still loading' ? 4500 : 2500));
    assert.deepEqual(wire.clients(before), []);
  });
}

test('residual a loading editor loses its longer wait when its origin becomes protected', {
  timeout: 6000,
}, async (t) => {
  const { wire, entry } = setup(t, 'editor-changed-origin');
  const timer = setTimeout(() => {
    entry.tree.childFrames[0].frame.securityOrigin = protectedOrigin;
  }, 200);
  t.after(() => clearTimeout(timer));
  const started = Date.now();
  const answer = await wire.send('Target.attachToTarget', {
    targetId: entry.info.targetId,
    flatten: true,
  });
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
  assert.ok(Date.now() - started < 2500);
  assert.equal(
    wire.sent.some((message) => message.method === 'Target.closeTarget'),
    false
  );
});
