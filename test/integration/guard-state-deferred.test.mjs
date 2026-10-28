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
  entry.tree.frame = { ...errorFrame('deferred'), loaderId: 'deferred-error-loader' };
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
  'different ordinary error commit',
  'Page.navigate',
  'Page.reload',
  'Target.closeTarget',
]) {
  test(`deferred wipe is cancelled by ${cancel} and cannot replace a client page`, async (t) => {
    const { wire, entry, session } = await blocked(t);
    if (cancel.includes('commit')) {
      const frame =
        cancel === 'different ordinary error commit'
          ? {
              ...errorFrame('deferred'),
              loaderId: 'different-error-loader',
              unreachableUrl: ordinary,
            }
          : plainFrame('deferred');
      entry.tree.frame = frame;
      entry.info.url = frame.url;
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

for (const action of [
  'guardian duplicate',
  'client duplicate',
  'unknown duplicate',
  'child commit',
  'Page.getNavigationHistory',
  'Page.enable',
  'Page.disable',
  'Page.stopLoading',
  'Target.getTargetInfo',
  'Target.getTargets',
  'Target.attachToTarget',
  'Target.activateTarget',
]) {
  test(`deferred wipe survives ${action} while the main error document remains`, async (t) => {
    const { wire, entry, session } = await blocked(t);
    if (action.includes('duplicate') || action === 'child commit') {
      const frame =
        action === 'child commit'
          ? plainFrame('child', 'deferred')
          : {
              ...entry.tree.frame,
              ...(action === 'unknown duplicate' ? { loaderId: undefined } : {}),
            };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: action === 'client duplicate' ? session : 'guard-deferred',
        params: { frame },
      });
    } else {
      const browser = action.startsWith('Target.');
      const answer = await wire.send(
        action,
        browser ? { targetId: 'deferred', flatten: true } : {},
        browser ? undefined : session
      );
      assert.equal(answer.error, undefined);
    }
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(wipes(wire).length, 1);
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  });
}

test('deferred wipe is cancelled only by a successful stop of an active main load away', async (t) => {
  const { wire, session } = await blocked(t);
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: 'guard-deferred',
    params: {
      frameId: 'deferred',
      url: ordinary,
      loaderId: 'away-loader',
      navigationType: 'differentDocument',
    },
  });
  assert.equal((await wire.send('Page.stopLoading', {}, session)).error, undefined);
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(wipes(wire).length, 0);
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
});

test('deferred wipe survives a failed stop of a main load away', async (t) => {
  const { wire, session } = await blocked(t);
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: 'guard-deferred',
    params: {
      frameId: 'deferred',
      url: ordinary,
      loaderId: 'away-loader',
      navigationType: 'differentDocument',
    },
  });
  wire.hold((message) => {
    if (message.method !== 'Page.stopLoading' || message.id >= 2 ** 30) return false;
    queueMicrotask(() =>
      wire.release(message, { error: { code: -32000, message: 'load could not stop' } })
    );
    return true;
  });
  assert.equal(
    (await wire.send('Page.stopLoading', {}, session)).error?.message,
    'load could not stop'
  );
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(wipes(wire).length, 1);
});

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
