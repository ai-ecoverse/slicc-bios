import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alwaysAllowed, approval, useSecretRules } from '../../src/seed/approvals.js';

useSecretRules(() => ({ certain: null, maybe: null }));

const request = (path, args) => ({
  id: 1,
  path,
  argv: [path, ...args],
  user: 'cone',
  tag: '{}',
  target: 'root',
  cwd: '/',
  createdAt: 0,
  expiresAt: 1,
});

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const CODES = [...range(0x00, 0x1f), ...range(0x7f, 0x9f), 0x2028, 0x2029];
const name = (code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

test('an ordinary command line is still offered always', () => {
  const plain = request('/usr/bin/ls', ['-la', '/root']);
  assert.equal(alwaysAllowed(plain), true);
  assert.equal(approval(plain).always, true);
});

for (const code of CODES) {
  const char = String.fromCodePoint(code);
  test(`always is not offered for a command line with ${name(code)}`, () => {
    for (const bad of [
      request('/usr/bin/ls', ['-la', `/root${char}x`]),
      request('/usr/bin/ls', [`${char}/root`]),
      request(`/usr/bin/l${char}s`, ['/root']),
    ]) {
      assert.equal(alwaysAllowed(bad), false);
      assert.equal(approval(bad).always, false);
    }
  });
}
