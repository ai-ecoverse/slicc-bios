import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { plainReplayAttempts } from './cdp-675-plain-retry.mjs';

const wire = (at, direction, packet, connectionId = 1) => ({
  at,
  boundary: 'bios',
  direction,
  packet,
  connectionId,
});
const reload = wire(0, 'send', { id: 1, method: 'Page.reload', sessionId: 'ROOT' });
const attach = wire(10, 'send', {
  id: 2,
  method: 'Target.attachToTarget',
  params: { flatten: true, targetId: 'T' },
});
const attached = wire(20, 'receive', { id: 2, result: { sessionId: 'FRESH' } });
const enable = (at, id) =>
  wire(at, 'send', { id, method: 'Runtime.enable', sessionId: 'FRESH', params: {} });
const refused = (at, id) =>
  wire(at, 'receive', {
    id,
    sessionId: 'FRESH',
    error: { code: -32000, message: 'slicc: refused: protected' },
  });

test('675 plain replay trace counts only the same fresh session through two refusals and acceptance', () => {
  const methods = [
    reload,
    attach,
    attached,
    enable(25, 3),
    refused(30, 3),
    wire(35, 'receive', { id: 4, result: {} }, 2),
    enable(130, 4),
    refused(140, 4),
    enable(240, 5),
    wire(250, 'receive', { id: 5, result: {} }),
    enable(400, 6),
  ];
  const result = plainReplayAttempts(methods);
  assert.equal(result.sessionId, 'FRESH');
  assert.equal(result.attemptCount, 3);
  assert.deepEqual(
    result.attempts.map(({ outcome }) => outcome),
    ['refused', 'refused', 'accepted']
  );
  assert.deepEqual(
    result.attempts.map(({ id }) => id),
    [3, 4, 5]
  );
  assert.deepEqual(
    result.attempts.map(({ replyAt }) => replyAt),
    [30, 140, 250]
  );
});

test('675 plain replay trace retains every bounded refusal without inventing an install', () => {
  const result = plainReplayAttempts([
    reload,
    attach,
    attached,
    enable(25, 3),
    refused(30, 3),
    enable(130, 4),
    refused(140, 4),
  ]);
  assert.equal(result.attemptCount, 2);
  assert.deepEqual(
    result.attempts.map(({ outcome }) => outcome),
    ['refused', 'refused']
  );
  assert.equal(result.attempts[1].sinceReloadMs, 130);
});

test('675 plain replay trace distinguishes attach refusal, no reload and missing replies', () => {
  assert.equal(plainReplayAttempts([]), null);
  assert.equal(plainReplayAttempts([reload]), null);
  const refusedAttach = plainReplayAttempts([
    reload,
    attach,
    wire(15, 'receive', { id: 2, error: { message: 'refused' } }),
  ]);
  assert.equal(refusedAttach.attemptCount, 0);
  assert.equal(refusedAttach.attachError.message, 'refused');
  const pending = plainReplayAttempts([reload, attach, attached, enable(25, 3)]);
  assert.equal(pending.attempts[0].outcome, 'unanswered');
});

test('675 packaged rig captures fallback attempt counts on the terminal trace before counting the row', async () => {
  const source = await readFile(
    process.env.CDP_675_RIG_SOURCE ?? new URL('./cdp-675-packaged.test.mjs', import.meta.url),
    'utf8'
  );
  const at = source.indexOf(
    'if (foreign) row.plainReplayAttempts = plainReplayAttempts(row.methods);'
  );
  assert.ok(at > source.indexOf('row.methods = await page', source.indexOf('} finally {')));
  assert.ok(at < source.lastIndexOf('countRow(row);'));
});
