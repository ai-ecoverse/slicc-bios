import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPlainReplayBound } from './cdp-675-plain-bound.mjs';

const wire = (at, direction, packet) => ({
  at,
  direction,
  packet,
  boundary: 'bios',
  connectionId: 1,
});
const start = () => [
  wire(0, 'send', { id: 1, method: 'Page.reload' }),
  wire(10, 'send', { id: 2, method: 'Target.attachToTarget' }),
  wire(20, 'receive', { id: 2, result: { sessionId: 'fresh' } }),
];
const enable = (at, id = 3, sessionId = 'fresh') =>
  wire(at, 'send', { id, method: 'Runtime.enable', sessionId });
const answer = (at, id = 3, accepted = false) =>
  wire(at, 'receive', {
    id,
    ...(accepted ? { result: {} } : { error: { message: 'slicc: refused: protected' } }),
  });
const install = (at) =>
  wire(at, 'send', {
    id: 5,
    method: 'Runtime.evaluate',
    sessionId: 'fresh',
    params: { expression: 'const __wmcp_private = {};' },
  });

test('675 bounded same-session refusal then acceptance permits only the accepted install', () => {
  const result = assertPlainReplayBound([
    ...start(),
    enable(25),
    answer(30),
    enable(130, 4),
    answer(140, 4, true),
    install(141),
  ]);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.installCount, 1);
  assert.deepEqual(
    result.attempts.map(({ outcome }) => outcome),
    ['refused', 'accepted']
  );
});

test('675 terminal refused attach and persistent refused enables install nothing', () => {
  assert.equal(assertPlainReplayBound([start()[0], start()[1], answer(20, 2)]).attemptCount, 0);
  const methods = [...start()];
  for (let index = 0; index < 10; index++)
    methods.push(enable(25 + index * 101, index + 3), answer(26 + index * 101, index + 3));
  assert.equal(assertPlainReplayBound(methods).attemptCount, 10);
  assert.throws(() => assertPlainReplayBound([...methods, install(950)]), /nothing may install/);
});

test('675 plain replay rejects out-of-bound, too-fast, different-session and post-acceptance retries', () => {
  for (const at of [100, 1025])
    assert.throws(() =>
      assertPlainReplayBound([...start(), enable(25), answer(30), enable(at, 4), answer(at + 1, 4)])
    );
  assert.throws(() => assertPlainReplayBound([...start(), enable(25, 3, 'other'), answer(30)]));
  assert.throws(() =>
    assertPlainReplayBound([
      ...start(),
      enable(25),
      answer(30, 3, true),
      enable(140, 4),
      answer(150, 4, true),
    ])
  );
  assert.throws(() => assertPlainReplayBound([...start(), enable(25), answer(30), install(40)]));
  assert.throws(() =>
    assertPlainReplayBound([...start(), enable(25), answer(30, 3, true), install(29)])
  );
  assert.throws(() => assertPlainReplayBound([...start(), enable(25)]));
});

test('675 plain replay never reattaches or reloads after the fresh attachment', () => {
  assert.throws(() =>
    assertPlainReplayBound([
      ...start(),
      wire(25, 'send', { id: 9, method: 'Target.attachToTarget' }),
    ])
  );
  assert.throws(() =>
    assertPlainReplayBound([...start(), wire(25, 'send', { id: 9, method: 'Page.reload' })])
  );
});
