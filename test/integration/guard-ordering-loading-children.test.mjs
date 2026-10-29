import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-ordering-fixture.mjs';

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

for (const variant of ['parent without loader', 'protected child']) {
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

for (const origin of [new URL(ordinary).origin, '://']) {
  test(`residual unresolved editor children gate the page but not root Runtime ${origin}`, {
    timeout: 10000,
  }, async (t) => {
    const { wire, entry } = setup(t, 'editor-root-gating');
    for (const child of entry.tree.childFrames) child.frame.securityOrigin = origin;
    const started = Date.now();
    const session = await wire.attach(entry.info.targetId);
    assert.ok(Date.now() - started >= 2800);
    assert.ok(Date.now() - started < 7500);
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
      undefined
    );
    for (const method of ['DOM.getDocument', 'Page.captureScreenshot']) {
      const mark = wire.sent.length;
      assert.match((await wire.send(method, {}, session)).error?.message ?? '', /^slicc: refused:/);
      assert.deepEqual(wire.clients(mark), []);
    }
    for (const [index, child] of entry.tree.childFrames.entries()) {
      child.frame.url = index === 0 ? 'about:blank' : 'about:srcdoc';
      child.frame.securityOrigin = new URL(ordinary).origin;
      child.frame.loaderId = 'editor-commit';
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-editor-root-gating',
        params: { frame: child.frame },
      });
    }
    await flush();
    for (const method of ['DOM.getDocument', 'Page.captureScreenshot'])
      assert.equal((await wire.send(method, {}, session)).error, undefined);
  });
}

for (const commit of ['ordinary', 'protected', 'error']) {
  test(`residual an initial child context preserves root Runtime before a ${commit} commit`, {
    timeout: 6000,
  }, async (t) => {
    const wire = protocol(t);
    const id = 'editor-context-owner';
    const entry = wire.target(id);
    entry.tree.frame.loaderId = 'ordinary-context-root';
    const session = await wire.attach(id);
    await wire.send('Runtime.enable', {}, session);
    const child = { ...plainFrame('context-editor', id), url: '', securityOrigin: '://' };
    entry.tree.childFrames = [{ frame: child }];
    wire.emit({
      method: 'Page.frameAttached',
      sessionId: `guard-${id}`,
      params: { frameId: child.id, parentFrameId: id },
    });
    wire.hold(
      (message) =>
        message.id >= 2 ** 30 &&
        message.method === 'Runtime.evaluate' &&
        message.params.expression === 'location.href'
    );
    wire.emit({
      method: 'Runtime.executionContextCreated',
      sessionId: session,
      params: {
        context: {
          id: 401,
          uniqueId: 'initial-editor-context',
          origin: '://',
          auxData: { frameId: child.id, isDefault: true, type: 'default' },
        },
      },
    });
    await flush();
    const pending = wire.held.find((message) => message.method === 'Runtime.evaluate');
    assert.ok(pending);
    wire.hold(() => false);
    wire.release(pending, { result: { result: { type: 'string', value: 'about:blank' } } });
    const read = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    assert.equal(read.error, undefined);
    const forwarded = wire.clients().filter((message) => message.method === 'Runtime.evaluate');
    assert.equal(forwarded.at(-1).params.uniqueContextId, undefined);
    assert.equal(
      wire.delivered.some(
        (message) => message.params?.context?.uniqueId === 'initial-editor-context'
      ),
      false
    );
    const mark = wire.sent.length;
    assert.match(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: 'document.title', contextId: 401 },
          session
        )
      ).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.deepEqual(wire.clients(mark), []);
    for (const method of ['DOM.getDocument', 'Page.captureScreenshot'])
      assert.match((await wire.send(method, {}, session)).error?.message ?? '', /^slicc: refused:/);
    entry.tree.childFrames[0].frame =
      commit === 'error'
        ? errorFrame(child.id, id)
        : {
            ...plainFrame(child.id, id),
            loaderId: 'editor-context-commit',
            ...(commit === 'protected'
              ? { url: `${protectedOrigin}/page`, securityOrigin: protectedOrigin }
              : {}),
          };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: `guard-${id}`,
      params: { frame: entry.tree.childFrames[0].frame },
    });
    await flush();
    for (const method of ['DOM.getDocument', 'Page.captureScreenshot']) {
      const answer = await wire.send(method, {}, session);
      if (commit === 'ordinary') assert.equal(answer.error, undefined);
      else assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    }
    if (commit === 'protected')
      assert.match(
        (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error
          ?.message ?? '',
        /^slicc: refused:/
      );
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
