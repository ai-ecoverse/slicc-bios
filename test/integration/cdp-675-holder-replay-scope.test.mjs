import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPlainReplayBound } from './cdp-675-plain-bound.mjs';
import { plainReplayAttempts } from './cdp-675-plain-retry.mjs';

const packet = (at, connectionId, direction, value) => ({
  at,
  connectionId,
  boundary: 'bios',
  direction,
  packet: value,
});
const send = (at, connectionId, id, method, sessionId) =>
  packet(at, connectionId, 'send', { id, method, sessionId });
const reply = (at, connectionId, id, result) => packet(at, connectionId, 'receive', { id, result });
const unrelated = [
  send(100, 1, 1, 'Page.reload', 'holder-old'),
  send(110, 2, 1, 'Target.attachToTarget'),
  reply(111, 2, 1, { sessionId: 'observer' }),
  send(112, 2, 2, 'Runtime.enable', 'observer'),
  reply(113, 2, 2, {}),
];

test('plain replay ignores another connection even when it attaches before the holder', () => {
  const methods = [
    ...unrelated,
    send(120, 1, 2, 'Target.attachToTarget'),
    reply(121, 1, 2, { sessionId: 'holder-new' }),
    send(122, 1, 3, 'Runtime.enable', 'holder-new'),
    reply(123, 1, 3, {}),
  ];
  assert.equal(plainReplayAttempts(methods).sessionId, 'holder-new');
  assert.equal(assertPlainReplayBound(methods).sessionId, 'holder-new');
});

test('an independent listing attachment cannot stand in for a missing holder replay', () => {
  assert.equal(plainReplayAttempts(unrelated), null);
  assert.throws(() => assertPlainReplayBound(unrelated), /one fresh attachment/);
});

test('owning connection remains bounded to one fresh attachment and no second reload', () => {
  const methods = [
    send(100, 1, 1, 'Page.reload', 'holder-old'),
    send(120, 1, 2, 'Target.attachToTarget'),
    reply(121, 1, 2, { sessionId: 'holder-new' }),
    send(122, 1, 3, 'Runtime.enable', 'holder-new'),
    reply(123, 1, 3, {}),
  ];
  assert.throws(
    () => assertPlainReplayBound([...methods, send(124, 1, 4, 'Target.attachToTarget')]),
    /2 !== 1/
  );
  assert.throws(
    () => assertPlainReplayBound([...methods, send(124, 1, 4, 'Page.reload', 'holder-new')]),
    /true !== false/
  );
});

const source = await readFile(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const trigger = row.methods.findIndex(');
const end = source.indexOf('const after = row.methods.slice(trigger + 1);', start);
assert.ok(start >= 0 && end > start);
const trigger = new Function('row', 'assert', `${source.slice(start, end)}\nreturn trigger;`);

test('the early link clear-message branch recognizes its exact real other-extension refusal and not protected failures', () => {
  const row = (message) => ({ methods: [packet(100, 1, 'receive', { error: { message } })] });
  assert.equal(
    trigger(row('slicc: refused: that execution context belongs to a browser extension'), assert),
    0
  );
  assert.throws(
    () => trigger(row("slicc: refused: target is on seven's origin"), assert),
    /real other-extension cause/
  );
  assert.throws(
    () => trigger(row('native transport failed'), assert),
    /real other-extension cause/
  );
});
