import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, guardProtected, PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-state-fixture.mjs';

async function blocked(t, protect) {
  const wire = protocol(t, protect);
  const entry = wire.target('deferred');
  const session = await wire.attach('deferred');
  await wire.send('Page.enable', {}, session);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: 'guard-deferred',
    params: {
      requestId: 'blocked',
      frameId: 'deferred',
      resourceType: 'Document',
      request: { url: failed },
    },
  });
  await flush();
  entry.tree.frame = errorFrame('deferred');
  entry.info.url = entry.tree.frame.url;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-deferred',
    params: { frame: entry.tree.frame },
  });
  wire.emit({
    method: 'Page.frameStoppedLoading',
    sessionId: 'guard-deferred',
    params: { frameId: 'deferred' },
  });
  await flush();
  return { wire, entry, session };
}

const wipes = (wire) =>
  wire.sent.filter(
    (message) => message.method === 'Page.navigate' && message.params.url === BLANKED
  );

test('deferred wipe leaves the error document sealed for the entire five-second interval', async (t) => {
  const { wire, entry, session } = await blocked(t);
  assert.equal(wipes(wire).length, 0);
  for (const method of ['Runtime.evaluate', 'DOM.getDocument', 'Page.captureScreenshot'])
    assert.equal((await wire.send(method, {}, session)).error?.message, PROTECTED);
  const mark = wire.delivered.length;
  wire.emit({
    method: 'DOM.childNodeInserted',
    sessionId: session,
    params: { node: { nodeValue: 'private body' } },
  });
  wire.emit({
    method: 'Page.screencastFrame',
    sessionId: session,
    params: { data: 'private shot' },
  });
  await flush();
  assert.equal(
    wire.delivered
      .slice(mark)
      .some((message) =>
        ['DOM.childNodeInserted', 'Page.screencastFrame'].includes(message.method)
      ),
    false
  );
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(wipes(wire).length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(wipes(wire).length, 1);
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  entry.tree.frame = { ...plainFrame('deferred'), url: BLANKED, securityOrigin: 'null' };
  entry.info.url = BLANKED;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-deferred',
    params: { frame: entry.tree.frame },
  });
  await flush();
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error, undefined);
});

for (const cancel of [
  'main commit',
  'child commit',
  'error commit',
  'Page.navigate',
  'Page.reload',
  'Page.stopLoading',
  'Page.enable',
  'Page.disable',
  'Target.attachToTarget',
  'Target.closeTarget',
]) {
  test(`deferred wipe is cancelled by ${cancel} and cannot replace a client page`, async (t) => {
    const { wire, entry, session } = await blocked(t);
    if (cancel.includes('commit')) {
      const frame =
        cancel === 'error commit'
          ? errorFrame('deferred')
          : plainFrame(
              cancel === 'child commit' ? 'child' : 'deferred',
              cancel === 'child commit' ? 'deferred' : undefined
            );
      if (!frame.parentId) {
        entry.tree.frame = frame;
        entry.info.url = frame.url;
      }
      wire.emit({ method: 'Page.frameNavigated', sessionId: 'guard-deferred', params: { frame } });
    } else {
      const answer = await wire.send(
        cancel,
        cancel.startsWith('Target.') ? { targetId: 'deferred', flatten: true } : { url: ordinary },
        cancel.startsWith('Target.') ? undefined : session
      );
      assert.equal(answer.error, undefined);
      entry.tree.frame = plainFrame('deferred');
      entry.info.url = ordinary;
    }
    await flush();
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(wipes(wire).length, 0);
  });
}

test('deferred expiry cannot wipe after an exit cancels its in-flight private tree answer', async (t) => {
  const { wire, entry, session } = await blocked(t);
  wire.hold(
    (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-deferred'
  );
  t.mock.timers.tick(5000);
  await flush();
  const expiry = wire.held[0];
  assert.ok(expiry);
  wire.hold(() => false);
  assert.equal((await wire.send('Page.navigate', { url: ordinary }, session)).error, undefined);
  entry.tree.frame = plainFrame('deferred');
  entry.info.url = ordinary;
  wire.release(expiry, { result: { frameTree: { frame: errorFrame('deferred') } } });
  await flush();
  assert.equal(wipes(wire).length, 0);
});

test('deferred scrub is disarmed when its guarded client closes', async (t) => {
  let connection;
  const { wire } = await blocked(t, (raw, own) => {
    connection = guardProtected(raw, own);
    return connection;
  });
  connection.close();
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(wipes(wire).length, 0);
});
