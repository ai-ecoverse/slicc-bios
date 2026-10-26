import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const boundary of ['load-stop', 'navigation']) {
  test(`ordering pending ordinary reply ${boundary}`, async (t) => {
    const wire = protocol(t);
    wire.target('live');
    const session = await wire.attach('live');
    wire.hold((message) => message.method === 'Runtime.evaluate' && message.id < 2 ** 30);
    const read = wire.request('Runtime.evaluate', { expression: 'document.title' }, session);
    await flush();
    const answer = wire.held.find((message) => message.id === read.id);
    assert.ok(answer);
    wire.emit(
      boundary === 'load-stop'
        ? {
            method: 'Page.frameStoppedLoading',
            sessionId: 'guard-live',
            params: { frameId: 'live' },
          }
        : {
            method: 'Page.frameNavigated',
            sessionId: 'guard-live',
            params: { frame: plainFrame('live') },
          }
    );
    await flush();
    wire.release(answer);
    const result = await read.answer;
    if (boundary === 'load-stop')
      assert.equal(
        result.error,
        undefined,
        'load completion alone does not replace the admitted document'
      );
    else assert.match(result.error?.message ?? '', /^slicc: refused:/);
  });
}

test('ordering private iframe cleanup recognizes its target-root commit with a parent', async (t) => {
  const wire = protocol(t);
  wire.target('parent');
  const parent = await wire.attach('parent');
  wire.target('child', 'iframe', plainFrame('child', 'parent'), 'parent');
  wire.attached('child', parent);
  await flush();
  const mark = wire.sent.length;
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: 'guard-child',
    params: {
      requestId: 'blocked-child',
      frameId: 'child',
      resourceType: 'Document',
      request: { url: failed },
    },
  });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-child',
    params: { frame: errorFrame('child', 'parent') },
  });
  wire.emit({
    method: 'Page.frameStoppedLoading',
    sessionId: 'guard-child',
    params: { frameId: 'child' },
  });
  await flush();
  assert.ok(
    wire.sent
      .slice(mark)
      .some(
        (message) =>
          message.method === 'Page.navigate' &&
          message.sessionId === 'guard-child' &&
          message.params.url === BLANKED
      ),
    'the blocked iframe is cleaned without navigating or cutting its ordinary parent'
  );
  assert.equal(
    wire.sent
      .slice(mark)
      .some(
        (message) => message.method === 'Page.navigate' && message.sessionId === 'guard-parent'
      ),
    false
  );
});

test('ordering ordinary initial attachment metadata is independently classified without a content read', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('classified-title');
  entry.info.title = 'synthetic-confirmed-title';
  const session = wire.attached('classified-title');
  await flush();
  await flush();
  const attached = wire.delivered.find(
    (event) => event.method === 'Target.attachedToTarget' && event.params.sessionId === session
  );
  assert.equal(attached?.params.targetInfo.title, 'synthetic-confirmed-title');
  const listed = await wire.send('Target.getTargetInfo', { targetId: 'classified-title' });
  assert.equal(listed.result.targetInfo.title, 'synthetic-confirmed-title');
  assert.ok(
    wire.sent.some(
      (message) =>
        message.method === 'Page.getFrameTree' && message.sessionId === 'guard-classified-title'
    )
  );
});
