import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';
import { flush, ordinary, plainFrame, protectedOrigin, protocol } from './guard-state-fixture.mjs';

const secret = `${protectedOrigin}/?code=SECRET-CODE`;
const protectedFrame = (id) => ({
  ...plainFrame(id),
  url: secret,
  securityOrigin: protectedOrigin,
});

function locked(t, id, type = 'page') {
  const wire = protocol(t);
  const entry = wire.target(id, type, protectedFrame(id));
  entry.info.title = 'SECRET-TITLE';
  return { wire, entry };
}

const forwarded = (wire, mark, method, targetId) =>
  wire
    .clients(mark)
    .some((message) => message.method === method && message.params?.targetId === targetId);

const unreached = async (wire, targetId) => {
  for (const [method, params] of [
    ['Target.getTargetInfo', { targetId }],
    ['Target.attachToTarget', { targetId, flatten: true }],
    ['Target.activateTarget', { targetId }],
    ['Browser.getWindowForTarget', { targetId }],
  ]) {
    const mark = wire.sent.length;
    const answer = await wire.send(method, params);
    assert.equal(answer.error?.message, PROTECTED, method);
    assert.equal(answer.result, undefined, method);
    assert.equal(forwarded(wire, mark, method, targetId), false, method);
  }
};

test('a protected tab can be closed while every way to reach it stays refused', async (t) => {
  const { wire } = locked(t, 'locked-tab');
  await unreached(wire, 'locked-tab');
  assert.equal((await wire.send('Target.getTargets')).result.targetInfos.length, 0);
  const mark = wire.sent.length;
  const closed = await wire.send('Target.closeTarget', { targetId: 'locked-tab' });
  assert.equal(closed.error, undefined);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'locked-tab'), true);
  assert.equal(JSON.stringify(wire.delivered).includes('SECRET'), false);
});

test('a tab that turns protected under its session stays cut but can be closed', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('turned');
  const session = await wire.attach('turned');
  entry.tree.frame = protectedFrame('turned');
  entry.info.url = secret;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-turned',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  for (const [method, params] of [
    ['Runtime.evaluate', { expression: 'document.title' }],
    ['Page.navigate', { url: ordinary }],
    ['Page.captureScreenshot', {}],
    ['Target.closeTarget', { targetId: 'turned' }],
  ]) {
    const mark = wire.sent.length;
    const answer = await wire.send(method, params, session);
    assert.match(answer.error?.message ?? '', /^slicc: refused:/, method);
    assert.equal(
      wire.clients(mark).some((message) => message.method === method),
      false,
      method
    );
  }
  await unreached(wire, 'turned');
  const mark = wire.sent.length;
  assert.equal((await wire.send('Target.closeTarget', { targetId: 'turned' })).error, undefined);
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'turned'), true);
  assert.equal(JSON.stringify(wire.delivered).includes('SECRET'), false);
});

test('a held sign-in tab can be closed but not reached', async (t) => {
  const wire = protocol(t);
  wire.target('held-sign-in');
  hold('held-sign-in');
  await unreached(wire, 'held-sign-in');
  const mark = wire.sent.length;
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'held-sign-in' })).error,
    undefined
  );
  assert.equal(forwarded(wire, mark, 'Target.closeTarget', 'held-sign-in'), true);
});

for (const type of ['iframe', 'service_worker', 'browser_ui', 'other']) {
  test(`a protected ${type} target stays unclosable`, async (t) => {
    const { wire } = locked(t, `locked-${type}`, type);
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: `locked-${type}` });
    assert.equal(answer.error?.message, PROTECTED);
    assert.equal(forwarded(wire, mark, 'Target.closeTarget', `locked-${type}`), false);
  });
}
