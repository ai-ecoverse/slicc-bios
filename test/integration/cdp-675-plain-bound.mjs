import assert from 'node:assert/strict';
import { plainReplayAttempts } from './cdp-675-plain-retry.mjs';

export function assertPlainReplayBound(methods) {
  const replay = plainReplayAttempts(methods);
  assert.ok(replay, 'plain replay must have one fresh attachment');
  const connectionId = methods.find(
    ({ at, boundary, direction, packet }) =>
      at === replay.attachAt &&
      boundary === 'bios' &&
      direction === 'send' &&
      packet.method === 'Target.attachToTarget'
  ).connectionId;
  const sends = methods.filter(
    ({ at, boundary, direction, connectionId: id }) =>
      id === connectionId && at >= replay.attachAt && boundary === 'bios' && direction === 'send'
  );
  assert.equal(sends.filter(({ packet }) => packet.method === 'Target.attachToTarget').length, 1);
  assert.equal(
    sends.some(({ packet }) => packet.method === 'Page.reload'),
    false
  );
  const enables = sends.filter(({ packet }) => packet.method === 'Runtime.enable');
  assert.equal(enables.length, replay.attemptCount);
  assert.ok(replay.attemptCount <= 10, 'plain enable allows at most ten attempts');
  const first = replay.attempts[0];
  for (const [index, attempt] of replay.attempts.entries()) {
    assert.equal(attempt.sessionId, replay.sessionId);
    assert.ok(attempt.at - first.at < 1000, 'plain enable must stay inside its one-second cap');
    assert.notEqual(attempt.outcome, 'unanswered');
    if (index) {
      const previous = replay.attempts[index - 1];
      assert.equal(previous.outcome, 'refused');
      assert.ok(attempt.at - previous.replyAt >= 100, 'plain enable waits 100ms after refusal');
    }
  }
  const accepted = replay.attempts.find(({ outcome }) => outcome === 'accepted');
  const installs = sends.filter(
    ({ packet }) =>
      packet.method === 'Runtime.evaluate' && /^const __wmcp_/.test(packet.params?.expression ?? '')
  );
  for (const install of installs) {
    assert.ok(accepted, 'nothing may install unless the fresh enable was accepted');
    assert.equal(install.packet.sessionId, replay.sessionId);
    assert.ok(install.at >= accepted.replyAt, 'install must follow the accepted reply');
  }
  assert.ok(installs.length <= 1);
  return { ...replay, installCount: installs.length };
}
