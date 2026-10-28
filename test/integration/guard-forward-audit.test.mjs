import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectedOrigin, protocol } from './guard-state-fixture.mjs';

const { auditForwards } = await import(
  process.env.GUARD_AUDIT_SOURCE ?? './guard-forward-audit.mjs'
);
const method = 'DOM.getDocument';
const params = { depth: -1, pierce: true };
const probe = (id, sentAt = Date.now()) => ({ id, method, params, sentAt });

test('a refused public restore probe is not mistaken for a private placement query', async (t) => {
  const p = protocol(t);
  p.target('restored-page');
  const sessionId = await p.attach('restored-page');
  const sentAt = Date.now();
  p.emit({
    method: 'Page.frameNavigated',
    sessionId,
    params: {
      type: 'BackForwardCacheRestore',
      frame: {
        id: 'restored-page',
        url: `${protectedOrigin}/restored`,
        securityOrigin: protectedOrigin,
      },
    },
  });
  const request = p.request(method, params, sessionId);
  const answer = await request.answer;
  assert.match(answer.error.message, /refused/);
  const commands = [{ id: request.id, method, params, sessionId, at: sentAt }];
  const forwards = p.sent.map((message) => ({ ...message, at: sentAt }));
  assert.ok(forwards.some((message) => message.method === method));
  const audit = auditForwards(forwards, commands, [probe(1, sentAt)], sessionId);
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.probes, [{ id: 1, forwarded: false }]);
});

test('a public restore probe deliberately let through is still flagged as forwarded', async (t) => {
  const p = protocol(t, (wire) => wire);
  const sessionId = 'public-restore-session';
  const sentAt = Date.now();
  p.emit({
    method: 'Page.frameNavigated',
    sessionId,
    params: {
      type: 'BackForwardCacheRestore',
      frame: { id: 'restored-page', url: `${protectedOrigin}/restored` },
    },
  });
  const request = p.request(method, params, sessionId);
  const answer = await request.answer;
  assert.equal(answer.error, undefined);
  const commands = [{ id: request.id, method, params, sessionId, at: sentAt }];
  const audit = auditForwards(
    p.sent.map((message) => ({ ...message, at: sentAt })),
    commands,
    [probe(2, sentAt)],
    sessionId
  );
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.probes, [{ id: 2, forwarded: true }]);
});

test('the same wire id on a private session is not the public probe', () => {
  const sentAt = Date.now();
  const command = { id: 9, method, params, sessionId: 'public', at: sentAt };
  const audit = auditForwards(
    [{ ...command, sessionId: 'private' }],
    [command],
    [probe(3, sentAt)],
    'public'
  );
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.probes, [{ id: 3, forwarded: false }]);
});

test('two identical public probes retain their own forwarding identities', () => {
  const sentAt = Date.now();
  const commands = [5, 6].map((id) => ({ id, method, params, sessionId: 'public', at: sentAt }));
  const audit = auditForwards(
    [commands[1]],
    commands,
    [probe(4, sentAt), probe(5, sentAt)],
    'public'
  );
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.probes, [
    { id: 4, forwarded: false },
    { id: 5, forwarded: true },
  ]);
});

test('a public command remains forwarded when its outgoing parameters gain a context', () => {
  const sentAt = Date.now();
  const command = {
    id: 7,
    method: 'Runtime.evaluate',
    params: { expression: '1+1' },
    sessionId: 'public',
    at: sentAt,
  };
  const audit = auditForwards(
    [{ ...command, params: { ...command.params, uniqueContextId: 'current-world' } }],
    [command],
    [{ id: 6, method: command.method, params: command.params, sentAt }],
    'public'
  );
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.probes, [{ id: 6, forwarded: true }]);
});

test('missing public command identity is an incomplete audit, not non-forwarding proof', () => {
  const sentAt = Date.now();
  const audit = auditForwards([], [], [probe(7, sentAt)], 'public');
  assert.equal(audit.complete, false);
  assert.equal(audit.probes[0].forwarded, undefined);
});
