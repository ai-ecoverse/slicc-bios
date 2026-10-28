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

async function placed(t) {
  const wire = protocol(t);
  const root = wire.target('root');
  const session = await wire.attach('root');
  const frame = plainFrame('child', 'root');
  root.tree.childFrames = [{ frame }];
  const child = wire.target('child', 'iframe', frame, 'root');
  child.info.url = '';
  wire.sessions.set('placement-child', 'child');
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: 'guard-root',
    params: { sessionId: 'placement-child', targetInfo: child.info, waitingForDebugger: false },
  });
  await flush();
  child.info.url = ordinary;
  wire.emit({ method: 'Page.frameNavigated', sessionId: 'placement-child', params: { frame } });
  await flush();
  return { wire, root, child, session };
}

for (const namespace of ['same', 'distinct']) {
  test(`residual a privately placed error child keeps its frame identity ${namespace}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target(`parent-${namespace}`);
    const session = await wire.attach(`parent-${namespace}`);
    const targetId = `error-target-${namespace}`;
    const frameId = namespace === 'same' ? targetId : `error-frame-${namespace}`;
    const child = wire.target(
      targetId,
      'iframe',
      errorFrame(frameId, `parent-${namespace}`),
      `parent-${namespace}`
    );
    child.info.url = '';
    const placement = `error-placement-${namespace}`;
    wire.sessions.set(placement, targetId);
    wire.emit({
      method: 'Target.attachedToTarget',
      sessionId: `guard-parent-${namespace}`,
      params: { sessionId: placement, targetInfo: child.info, waitingForDebugger: false },
    });
    await flush();
    await flush();
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: placement,
      params: { frame: child.tree.frame },
    });
    await flush();
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error,
      undefined
    );
    for (const method of ['DOM.getDocument', 'Page.captureScreenshot', 'Input.dispatchKeyEvent']) {
      const mark = wire.sent.length;
      assert.match((await wire.send(method, {}, session)).error?.message ?? '', /^slicc: refused:/);
      assert.equal(
        wire.clients(mark).some((message) => message.method === method),
        false
      );
    }
    const mark = wire.sent.length;
    assert.match(
      (await wire.send('Runtime.evaluate', {}, placement)).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.equal(
      wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
      false
    );
  });
}

for (const method of ['Page.captureScreenshot', 'Page.startScreencast', 'DOM.getDocument']) {
  test(`residual an ordinary privately placed child preserves parent ${method}`, {
    timeout: 5000,
  }, async (t) => {
    const { wire, session } = await placed(t);
    const mark = wire.sent.length;
    assert.equal((await wire.send(method, {}, session)).error, undefined);
    assert.ok(wire.clients(mark).some((message) => message.method === method));
    assert.equal(
      wire.delivered.some((message) => message.params?.sessionId === 'placement-child'),
      false
    );
  });
}

for (const outcome of ['protected', 'malformed', 'metadata-error', 'tree-error', 'unanswered']) {
  test(`residual a privately placed child closes parent content on ${outcome} proof`, {
    timeout: 5000,
  }, async (t) => {
    const { wire, child, session } = await placed(t);
    if (outcome === 'protected') {
      child.tree = {
        frame: {
          ...child.tree.frame,
          url: `${protectedOrigin}/private`,
          securityOrigin: protectedOrigin,
        },
      };
    }
    if (outcome === 'malformed') child.tree = { frame: { ...child.tree.frame, url: '' } };
    const method = outcome === 'metadata-error' ? 'Target.getTargetInfo' : 'Page.getFrameTree';
    if (['metadata-error', 'tree-error', 'unanswered'].includes(outcome)) {
      wire.hold(
        (message) =>
          message.id >= 2 ** 30 &&
          message.method === method &&
          (method === 'Target.getTargetInfo'
            ? message.params.targetId === 'child'
            : message.sessionId === 'placement-child')
      );
    }
    const mark = wire.sent.length;
    const started = Date.now();
    const request = wire.request('DOM.getDocument', {}, session);
    if (['metadata-error', 'tree-error'].includes(outcome)) {
      await flush();
      wire.release(wire.held[0], {
        error: { code: -32000, message: 'synthetic owned proof failure' },
      });
    }
    if (outcome === 'unanswered') {
      wire.target('other');
      const other = await wire.attach('other');
      assert.equal((await wire.send('Runtime.evaluate', {}, other)).error, undefined);
    }
    const answer = await request.answer;
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.ok(Date.now() - started < 2500);
    assert.equal(
      wire
        .clients(mark)
        .some((message) => message.sessionId === session && message.method === 'DOM.getDocument'),
      false
    );
  });
}
