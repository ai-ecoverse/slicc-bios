import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { flush, ordinary, plainFrame, protectedOrigin, protocol } from './guard-state-fixture.mjs';

test('pass refusal log: blocked tags Runtime.enable after a protected surface cuts the session', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const wire = protocol(t);
  const entry = wire.target('pass-blocked', 'page', plainFrame('pass-blocked'));
  const session = await wire.attach('pass-blocked');
  assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);
  entry.info.url = `${protectedOrigin}/private`;
  entry.tree.frame = {
    id: 'pass-blocked',
    url: `${protectedOrigin}/private`,
    securityOrigin: protectedOrigin,
  };
  entry.history = {
    currentIndex: 0,
    entries: [{ id: 1, url: `${protectedOrigin}/private`, title: protectedOrigin }],
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: entry.tree.frame },
  });
  await flush();
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error?.message,
    PROTECTED
  );
  warnings.length = 0;
  assert.equal((await wire.send('Runtime.enable', {}, session)).error?.message, PROTECTED);
  assert.ok(
    warnings.some((line) =>
      line.includes('the CDP guard refused a command: target pass-blocked, Runtime.enable, blocked')
    ),
    `expected blocked pass log, got ${JSON.stringify(warnings)}`
  );
  assert.equal(ordinary.includes('ordinary'), true);
});

test('pass refusal log: ordinary Runtime.enable is silent', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const wire = protocol(t);
  wire.target('pass-ordinary', 'page', plainFrame('pass-ordinary'));
  const session = await wire.attach('pass-ordinary');
  assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);
  assert.equal(
    warnings.some((line) => line.includes('Runtime.enable') && line.includes('refused a command')),
    false,
    `ordinary enable must not log a pass refusal: ${JSON.stringify(warnings)}`
  );
});
