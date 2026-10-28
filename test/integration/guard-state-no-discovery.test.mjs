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

async function attachedError(t, targetId) {
  const wire = protocol(t);
  const entry = wire.target(targetId);
  const first = await wire.attach(targetId);
  entry.tree.frame = { ...errorFrame(targetId), loaderId: 'error-loader' };
  entry.info.url = failed;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${targetId}`,
    params: { frame: entry.tree.frame },
  });
  await flush();
  const second = wire.attached(targetId, undefined, `second-${targetId}`);
  await flush();
  for (const sessionId of [first, second])
    assert.equal((await wire.send('Runtime.evaluate', {}, sessionId)).error?.message, PROTECTED);
  return { wire, entry, sessions: [first, second] };
}

function commit(wire, entry, targetId, frame) {
  entry.tree.frame = frame;
  entry.info.url = frame.url;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${targetId}`,
    params: { frame },
  });
}

for (const destination of ['ordinary', 'private blank']) {
  test(`state error attachment releases only after a proved main commit without discovery: ${destination}`, {
    timeout: 5000,
  }, async (t) => {
    const targetId = `no-discovery-${destination.replaceAll(' ', '-')}`;
    const { wire, entry, sessions } = await attachedError(t, targetId);
    const frame = {
      ...plainFrame(targetId),
      url: destination === 'ordinary' ? ordinary : BLANKED,
      securityOrigin: destination === 'ordinary' ? new URL(ordinary).origin : 'null',
      loaderId: 'ordinary-loader',
    };
    commit(wire, entry, targetId, frame);
    await flush();
    assert.equal(
      wire.delivered.some(({ method }) => method === 'Target.targetInfoChanged'),
      false
    );
    for (const sessionId of sessions) {
      assert.equal((await wire.send('Runtime.evaluate', {}, sessionId)).error, undefined);
      assert.equal((await wire.send('DOM.getDocument', {}, sessionId)).error, undefined);
    }
  });
}

for (const failure of [
  'child commit',
  'error proof',
  'wrong root',
  'wrong URL',
  'parented root',
  'protected origin',
  'wrong loader',
  'missing loader',
  'invalid proof',
  'live protected child',
  'rejected protected loader',
]) {
  test(`state no-discovery main settlement stays sealed for ${failure}`, {
    timeout: 5000,
  }, async (t) => {
    const targetId = `no-discovery-negative-${failure.replaceAll(' ', '-')}`;
    const { wire, entry, sessions } = await attachedError(t, targetId);
    const frame = { ...plainFrame(targetId), loaderId: 'ordinary-loader' };
    if (failure === 'rejected protected loader')
      wire.emit({
        method: 'Page.frameStartedNavigating',
        sessionId: `guard-${targetId}`,
        params: {
          frameId: targetId,
          loaderId: 'pending-protected-loader',
          url: failed,
          navigationType: 'differentDocument',
        },
      });
    if (failure === 'child commit') {
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${targetId}`,
        params: { frame: { ...plainFrame('ordinary-child', targetId), loaderId: 'child-loader' } },
      });
    } else {
      entry.tree.frame =
        failure === 'error proof' ? { ...errorFrame(targetId), loaderId: 'error-loader' } : frame;
      entry.info.url = frame.url;
      if (failure === 'wrong root') entry.tree.frame = { ...frame, id: 'unobserved-root' };
      if (failure === 'wrong URL') entry.tree.frame = { ...frame, url: `${ordinary}?other` };
      if (failure === 'parented root') entry.tree.frame = { ...frame, parentId: 'unknown-parent' };
      if (failure === 'protected origin')
        entry.tree.frame = { ...frame, securityOrigin: new URL(failed).origin };
      if (failure === 'wrong loader') entry.tree.frame = { ...frame, loaderId: 'different-loader' };
      if (failure === 'missing loader') delete frame.loaderId;
      if (failure === 'live protected child')
        entry.tree.childFrames = [
          {
            frame: {
              ...plainFrame('live-child', targetId),
              url: failed,
              securityOrigin: new URL(failed).origin,
            },
          },
        ];
      if (failure === 'invalid proof')
        wire.hold((message) => {
          if (message.method !== 'Page.getFrameTree' || !sessions.includes(message.sessionId))
            return false;
          queueMicrotask(() =>
            wire.release(message, { error: { code: -32000, message: 'no matching root proof' } })
          );
          return true;
        });
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${targetId}`,
        params: { frame },
      });
    }
    await flush();
    for (const sessionId of sessions) {
      for (const method of [
        'Runtime.evaluate',
        'DOM.getDocument',
        'Page.captureScreenshot',
        'Network.getCookies',
        'Network.enable',
        'Runtime.enable',
      ])
        assert.equal((await wire.send(method, {}, sessionId)).error?.message, PROTECTED, method);
    }
  });
}
