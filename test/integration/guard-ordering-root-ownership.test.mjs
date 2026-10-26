import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-ordering-fixture.mjs';

for (const kind of ['ordinary', 'ordinary-error', 'protected']) {
  test(`ordering browser-scoped frame ownership ${kind}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('parent');
    const parent = await wire.attach('parent');
    await wire.send('Runtime.evaluate', { expression: '1' }, parent);
    wire.emit({
      method: 'Page.frameAttached',
      sessionId: 'guard-parent',
      params: { frameId: 'child-frame', parentFrameId: 'parent' },
    });
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: 'guard-parent',
      params: { frameId: 'child-frame', url: ordinary },
    });
    const frame =
      kind === 'ordinary'
        ? plainFrame('child-frame', 'parent')
        : {
            ...errorFrame('child-frame', 'parent'),
            ...(kind === 'ordinary-error'
              ? { unreachableUrl: 'https://network-error.invalid/synthetic' }
              : {}),
          };
    wire.target('child-target', 'iframe', frame);
    entry.tree.childFrames = [{ frame }];
    wire.attached('child-target');
    await flush();
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-child-target',
      params: { frame },
    });
    wire.emit({
      method: 'Page.frameStoppedLoading',
      sessionId: 'guard-child-target',
      params: { frameId: 'child-frame' },
    });
    await flush();
    const answers = await Promise.all([
      wire.send('Runtime.evaluate', { expression: '1' }, parent),
      wire.send('DOM.getDocument', {}, parent),
      wire.send('Page.captureScreenshot', {}, parent),
    ]);
    if (kind === 'protected')
      for (const answer of answers) assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    else
      assert.deepEqual(
        answers.map((answer) => answer.error),
        [undefined, undefined, undefined]
      );
  });
}

for (const namespace of ['page', 'iframe']) {
  test(`ordering quarantine owns an independent frame identifier ${namespace}`, async (t) => {
    const wire = protocol(t);
    let parent;
    if (namespace === 'iframe') {
      wire.target('parent');
      parent = await wire.attach('parent');
    }
    const entry = wire.target(
      'target-17',
      namespace,
      plainFrame('frame-hex-17', namespace === 'iframe' ? 'parent' : undefined)
    );
    if (parent) {
      wire.attached('target-17');
      await flush();
    } else await wire.attach('target-17');
    wire.emit({
      method: 'Fetch.requestPaused',
      sessionId: 'guard-target-17',
      params: {
        requestId: 'blocked-root',
        frameId: 'frame-hex-17',
        resourceType: 'Document',
        request: { url: failed },
      },
    });
    entry.tree = {
      frame: errorFrame('frame-hex-17', namespace === 'iframe' ? 'parent' : undefined),
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-target-17',
      params: { frame: entry.tree.frame },
    });
    wire.emit({
      method: 'Page.frameStoppedLoading',
      sessionId: 'guard-target-17',
      params: { frameId: 'frame-hex-17' },
    });
    await flush();
    assert.ok(
      wire.sent.some(
        (message) =>
          message.method === 'Fetch.failRequest' && message.params.requestId === 'blocked-root'
      )
    );
    assert.ok(
      wire.sent.some(
        (message) =>
          message.method === 'Page.navigate' &&
          message.sessionId === 'guard-target-17' &&
          message.params.url === BLANKED
      )
    );
  });
}

test('ordering conflicting physical root claims stay unclassified', async (t) => {
  const wire = protocol(t);
  wire.target('owner-a', 'page', plainFrame('shared-frame'));
  const original = await wire.attach('owner-a');
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '1' }, original)).error,
    undefined
  );
  wire.target('owner-b', 'page', plainFrame('shared-frame'));
  const answer = await wire.send('Target.attachToTarget', { targetId: 'owner-b', flatten: true });
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
});
