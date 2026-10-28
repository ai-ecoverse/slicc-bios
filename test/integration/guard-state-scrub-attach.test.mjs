import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-state-fixture.mjs';

test('state created blocked redirect attach escapes the deferred scrub without exposing the error document', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('created-scrub', 'page', plainFrame('created-scrub'));
  wire.hold((message) => message.method === 'Target.createTarget' && message.id >= 2 ** 30);
  const creating = wire.request('Target.createTarget', { url: ordinary });
  await flush();
  wire.release(
    wire.held.find((message) => message.method === 'Target.createTarget'),
    {
      result: { targetId: 'created-scrub' },
    }
  );
  assert.equal((await creating.answer).result.targetId, 'created-scrub');
  wire.hold(() => false);
  entry.tree.frame = errorFrame('created-scrub');
  entry.info.url = entry.tree.frame.url;
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: 'guard-created-scrub',
    params: {
      requestId: 'created-blocked-request',
      resourceType: 'Document',
      frameId: 'created-scrub',
      request: { url: failed },
    },
  });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-created-scrub',
    params: { frame: entry.tree.frame },
  });
  wire.emit({
    method: 'Page.frameStoppedLoading',
    sessionId: 'guard-created-scrub',
    params: { frameId: 'created-scrub' },
  });
  await flush();
  assert.equal(
    wire.sent.filter(({ method, params }) => method === 'Page.navigate' && params.url === BLANKED)
      .length,
    0
  );
  const mark = wire.sent.length;
  const attaching = wire.request('Target.attachToTarget', {
    targetId: 'created-scrub',
    flatten: true,
  });
  const attached = await attaching.answer;
  assert.equal(attached.error, undefined);
  const sessionId = attached.result.sessionId;
  assert.ok(wire.clients(mark).some((message) => message.method === 'Target.attachToTarget'));
  assert.equal((await wire.send('Runtime.evaluate', {}, sessionId)).error?.message, PROTECTED);
  assert.equal(
    (await wire.send('Page.captureScreenshot', {}, sessionId)).error?.message,
    PROTECTED
  );
  entry.tree.frame = { ...plainFrame('created-scrub'), url: BLANKED, securityOrigin: 'null' };
  entry.info.url = BLANKED;
  entry.info.title = 'blocked';
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-created-scrub',
    params: { frame: entry.tree.frame },
  });
  await flush();
  entry.info.url = BLANKED;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  const read = await wire.send('Runtime.evaluate', {}, sessionId);
  assert.equal(read.error, undefined);
  assert.equal((await wire.send('Page.captureScreenshot', {}, sessionId)).error, undefined);
  assert.equal((await wire.send('Target.getTargets')).result.targetInfos[0].url, BLANKED);
});
