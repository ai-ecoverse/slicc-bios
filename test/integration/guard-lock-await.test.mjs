import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from('synthetic-late-paint').toString('base64');

test('a paint answer awaiting its final document proof is cancelled without releasing its identity', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  t.after(() => {
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
  });
  wire.target('await-owner', 'page', plainFrame('await-root'));
  const session = await wire.attach('await-owner');
  let holdProof = false;
  wire.hold(
    (message) =>
      (message.method === 'Page.captureScreenshot' && message.id < 2 ** 30) ||
      (holdProof && message.method === 'Page.getFrameTree' && message.sessionId === session)
  );
  const original = wire.request('Page.captureScreenshot', {}, session, 930);
  await flush();
  const capture = wire.held.find((message) => message.method === 'Page.captureScreenshot');
  assert.ok(capture);
  holdProof = true;
  wire.release(capture, { result: { data: opaque } });
  await flush();
  const proof = wire.held.find(
    (message) => message.method === 'Page.getFrameTree' && message.sessionId === session
  );
  assert.ok(proof);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-await-owner',
    params: { frame: { ...plainFrame('await-protected-child', 'await-root'), url: failed } },
  });
  await flush();
  assert.equal(
    wire.delivered.find((answer) => answer.id === original.id && answer.sessionId === session)
      ?.error?.message,
    PROTECTED
  );
  assert.equal((await original.answer).error?.message, PROTECTED);
  const mark = wire.sent.length;
  assert.match(
    (await wire.request('Runtime.evaluate', { expression: '1' }, session, 930).answer).error
      ?.message ?? '',
    /^slicc: refused:/
  );
  assert.deepEqual(wire.clients(mark), []);
  const received = wire.delivered.length;
  wire.hold(() => false);
  wire.release(proof);
  await flush();
  assert.equal(JSON.stringify(wire.delivered.slice(received)).includes(opaque), false);
  assert.equal((await wire.request('Page.enable', {}, session, 930).answer).error, undefined);
});
