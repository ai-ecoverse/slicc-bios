import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

test('state a protected main start during a fresh commit proof keeps cookies and enables quarantined', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const targetId = 'witness-proof-race';
  const entry = wire.target(targetId);
  const client = await wire.attach(targetId);
  entry.tree.frame = { ...errorFrame(targetId), loaderId: 'initial-error' };
  entry.info.url = failed;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${targetId}`,
    params: { frame: entry.tree.frame },
  });
  await flush();
  const additional = wire.attached(targetId, undefined, 'witness-race-additional');
  await flush();
  const sessions = [client, additional];
  wire.hold(
    (message) => message.method === 'Page.getFrameTree' && sessions.includes(message.sessionId)
  );
  const ordinary = { ...plainFrame(targetId), loaderId: 'ordinary-witness' };
  entry.tree.frame = ordinary;
  entry.info.url = ordinary.url;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${targetId}`,
    params: { frame: ordinary },
  });
  await flush();
  const checks = wire.held.filter(
    (message) => message.method === 'Page.getFrameTree' && sessions.includes(message.sessionId)
  );
  assert.equal(checks.length, 2);
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: `guard-${targetId}`,
    params: {
      frameId: targetId,
      url: failed,
      loaderId: 'pending-protected',
      navigationType: 'differentDocument',
    },
  });
  for (const check of checks) wire.release(check, { result: { frameTree: { frame: ordinary } } });
  await flush();
  for (const session of sessions)
    for (const method of [
      'Runtime.evaluate',
      'DOM.getDocument',
      'Network.getCookies',
      'Network.enable',
      'Runtime.enable',
    ])
      assert.equal((await wire.send(method, {}, session)).error?.message, PROTECTED, method);
  wire.hold(() => false);
  entry.tree.frame = { ...ordinary, loaderId: 'pending-protected' };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${targetId}`,
    params: { frame: entry.tree.frame },
  });
  await flush();
  for (const session of sessions)
    for (const method of ['Runtime.evaluate', 'Network.getCookies', 'Network.enable'])
      assert.equal((await wire.send(method, {}, session)).error, undefined, method);
});
