import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-state-fixture.mjs';

const detached = (wire, session) =>
  wire.delivered.filter(
    (event) => event.method === 'Target.detachedFromTarget' && event.params.sessionId === session
  );

for (const acknowledgement of ['held', 'error', 'silent success']) {
  test(`a refused recovery proof notifies its shown session before a ${acknowledgement} detach acknowledgement`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('recover-cut');
    const session = await wire.attach('recover-cut');
    assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
    entry.tree.frame = { ...errorFrame('recover-cut'), loaderId: 'failed-loader' };
    entry.info.url = failed;
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-recover-cut',
      params: { frame: entry.tree.frame },
    });
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
    assert.equal((await wire.send('Page.navigate', { url: ordinary }, session)).error, undefined);
    wire.hold(
      (message) =>
        (message.method === 'Page.getFrameTree' && message.sessionId === session) ||
        (message.method === 'Target.detachFromTarget' && message.params.sessionId === session)
    );
    entry.tree.frame = { ...plainFrame('recover-cut'), loaderId: 'recovered-loader' };
    for (const sessionId of ['guard-recover-cut', session])
      wire.emit({ method: 'Page.frameNavigated', sessionId, params: { frame: entry.tree.frame } });
    await flush();
    const proofs = wire.held.filter((message) => message.method === 'Page.getFrameTree');
    assert.ok(proofs.length > 0);
    for (const message of proofs)
      wire.release(message, {
        error: { code: -32000, message: "slicc: refused: target is on seven's origin" },
      });
    await flush();
    const notice = { method: 'Target.detachedFromTarget', params: { sessionId: session } };
    assert.deepEqual(detached(wire, session), [notice]);
    const release = wire.held.find((message) => message.method === 'Target.detachFromTarget');
    assert.ok(release);
    if (acknowledgement !== 'held')
      wire.release(
        release,
        acknowledgement === 'error'
          ? { error: { code: -32000, message: 'synthetic detach failure' } }
          : { result: {} }
      );
    entry.info.url = ordinary;
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    for (const sessionId of [session, 'guard-recover-cut'])
      wire.emit({ method: 'Page.loadEventFired', sessionId, params: { timestamp: 1 } });
    wire.emit({
      method: 'Runtime.consoleAPICalled',
      sessionId: session,
      params: { args: [{ value: failed }] },
    });
    await flush();
    assert.deepEqual(detached(wire, session), [notice]);
    const mark = wire.sent.length;
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
    assert.equal(wire.clients(mark).length, 0);
    assert.equal(
      wire.delivered.some((event) => event.method === 'Page.loadEventFired'),
      false
    );
    assert.equal(
      wire.delivered.some((event) => event.method === 'Runtime.consoleAPICalled'),
      false
    );
    wire.emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: session, targetId: 'recover-cut', reason: failed },
    });
    await flush();
    assert.deepEqual(detached(wire, session), [notice]);
  });
}

for (const nested of [false, true]) {
  test(`a guard cut announces only a shown session and suppresses duplicate native notices, nested ${nested}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('cut-parent');
    const parent = await wire.attach('cut-parent');
    const entry = wire.target('cut-child');
    const session = nested ? wire.attached('cut-child', parent) : await wire.attach('cut-child');
    await flush();
    entry.tree.frame = {
      ...plainFrame('cut-child'),
      url: failed,
      securityOrigin: new URL(failed).origin,
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    await flush();
    const notice = {
      method: 'Target.detachedFromTarget',
      params: { sessionId: session },
      ...(nested ? { sessionId: parent } : {}),
    };
    assert.deepEqual(detached(wire, session), [notice]);
    for (let count = 0; count < 2; count += 1) {
      wire.emit({
        method: 'Target.detachedFromTarget',
        params: { sessionId: session, targetId: 'cut-child' },
        ...(nested ? { sessionId: parent } : {}),
      });
      await flush();
    }
    assert.deepEqual(detached(wire, session), [notice]);
    assert.equal((await wire.send('Runtime.evaluate', {}, parent)).error, undefined);
    const hidden = wire.target('never-shown');
    hidden.info.url = failed;
    hidden.tree.frame = {
      ...hidden.tree.frame,
      url: failed,
      securityOrigin: new URL(failed).origin,
    };
    const hiddenSession = wire.attached('never-shown');
    await flush();
    assert.deepEqual(detached(wire, hiddenSession), []);
  });
}

test('a native detach of an ordinary shown session still reaches the client once', async (t) => {
  const wire = protocol(t);
  wire.target('native-cut');
  const session = await wire.attach('native-cut');
  const notice = {
    method: 'Target.detachedFromTarget',
    params: { sessionId: session, targetId: 'native-cut' },
  };
  wire.emit(notice);
  await flush();
  assert.deepEqual(detached(wire, session), [notice]);
});
