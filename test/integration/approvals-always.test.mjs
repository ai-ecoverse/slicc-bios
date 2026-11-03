import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApprovals, routeSudo, useSecretRules } from '../../src/seed/approvals.js';

useSecretRules(() => ({ certain: null, maybe: null }));

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const CODES = [...range(0x00, 0x1f), ...range(0x7f, 0x9f), 0x2028, 0x2029];
const name = (code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

const request = (args) => ({
  id: 1,
  path: '/usr/bin/ls',
  argv: ['/usr/bin/ls', ...args],
  user: 'cone',
  tag: '{}',
  target: 'root',
  cwd: '/',
  createdAt: 0,
  expiresAt: Date.now() + 60000,
});

const turn = () => new Promise((resolve) => setImmediate(resolve));

async function ownerAnswers(args, answer) {
  const approvals = createApprovals({ channel: { postMessage() {}, close() {}, onmessage: null } });
  approvals.own();
  const sudo = routeSudo({
    agent: () => undefined,
    fallback: approvals.approve,
    offered: approvals.offered,
  });
  const decision = sudo(request(args), {});
  for (let i = 0; i < 100 && !approvals.port.list().length; i += 1) await turn();
  const [item] = approvals.port.list();
  await approvals.port.decide(item.id, answer);
  return { offered: item.always, decision: await decision };
}

async function agentAnswers(args, answer) {
  const approvals = createApprovals({ channel: { postMessage() {}, close() {}, onmessage: null } });
  const sudo = routeSudo({
    agent: () => ({ approve: async () => answer }),
    fallback: approvals.approve,
    offered: approvals.offered,
  });
  return sudo(request(args), {});
}

test('an ordinary command line is offered always, and the answer reaches the kernel', async () => {
  assert.deepEqual(await ownerAnswers(['-la', '/root'], 'always'), {
    offered: true,
    decision: 'always',
  });
  assert.equal(await agentAnswers(['-la', '/root'], 'always'), 'always');
});

for (const code of CODES) {
  const char = String.fromCodePoint(code);
  test(`a command line with ${name(code)} is never recorded as always`, async () => {
    const args = ['-la', `/root${char}x`];
    assert.deepEqual(await ownerAnswers(args, 'always'), { offered: false, decision: 'once' });
    assert.equal(await agentAnswers(args, 'always'), 'once');
  });
}
