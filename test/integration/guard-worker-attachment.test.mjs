import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainFrame, protectedOrigin, protocol } from './guard-state-fixture.mjs';

const workerTypes = ['service_worker', 'shared_worker', 'worker'];

for (const type of workerTypes) {
  for (const unavailable of ['unsupported', 'absent']) {
    test(`an ordinary ${type} attaches and reads without a frame tree (${unavailable})`, async (t) => {
      const p = protocol(t);
      const id = `ordinary-${type}-${unavailable}`;
      p.target(id, type).tree = undefined;
      if (unavailable === 'unsupported')
        p.hold((message) => {
          if (message.method !== 'Page.getFrameTree') return false;
          queueMicrotask(() =>
            p.release(message, {
              error: { code: -32601, message: 'Page.getFrameTree is unavailable' },
            })
          );
          return true;
        });
      const attached = await p.send('Target.attachToTarget', { targetId: id, flatten: true });
      assert.equal(attached.error, undefined);
      assert.ok(attached.result.sessionId);
      const read = await p.send(
        'Runtime.evaluate',
        { expression: '1+1', returnByValue: true },
        attached.result.sessionId
      );
      assert.equal(read.error, undefined);
      assert.equal(read.result.result.value, 'synthetic-content');
    });
  }

  test(`a protected ${type} cannot attach without a frame tree`, async (t) => {
    const p = protocol(t);
    const id = `protected-${type}`;
    p.target(id, type, {
      id,
      url: `${protectedOrigin}/worker.js`,
      securityOrigin: protectedOrigin,
    }).tree = undefined;
    const answer = await p.send('Target.attachToTarget', { targetId: id, flatten: true });
    assert.match(answer.error.message, /refused/);
    assert.equal(answer.result, undefined);
    assert.equal(
      p.clients().some((message) => message.method === 'Target.attachToTarget'),
      false
    );
  });

  test(`an ordinary ${type} with a protected frame-tree answer cannot attach`, async (t) => {
    const p = protocol(t);
    const id = `tree-${type}`;
    const entry = p.target(id, type);
    entry.tree = {
      frame: {
        id,
        url: `${protectedOrigin}/document`,
        securityOrigin: protectedOrigin,
      },
    };
    const answer = await p.send('Target.attachToTarget', { targetId: id, flatten: true });
    assert.match(answer.error.message, /refused/);
    assert.equal(answer.result, undefined);
  });
}

for (const type of ['page', 'iframe', 'background_page', 'webview', 'other']) {
  test(`a ${type} without a frame tree stays closed`, async (t) => {
    const p = protocol(t);
    const id = `missing-${type}`;
    p.target(id, type).tree = undefined;
    const answer = await p.send('Target.attachToTarget', { targetId: id, flatten: true });
    assert.match(answer.error.message, /refused/);
    assert.equal(answer.result, undefined);
  });
}

test('an ordinary page with a frame tree still attaches and reads', async (t) => {
  const p = protocol(t);
  p.target('ordinary-page', 'page', plainFrame('ordinary-page'));
  const attached = await p.send('Target.attachToTarget', {
    targetId: 'ordinary-page',
    flatten: true,
  });
  assert.equal(attached.error, undefined);
  const read = await p.send(
    'Runtime.evaluate',
    { expression: '1+1', returnByValue: true },
    attached.result.sessionId
  );
  assert.equal(read.error, undefined);
  assert.equal(read.result.result.value, 'synthetic-content');
});
