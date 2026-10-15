import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown, merge } from '../../scripts/canary/report.mjs';

const pins = {
  overrides: [{ name: '@ai-ecoverse/slicc-kernel', version: '1.86.0', sha256: 'a'.repeat(64) }],
  candidates: {},
  held: [],
};

function shard(exit, results, name = 'rest') {
  return {
    shard: name,
    files: ['test/integration/x.test.mjs'],
    startedAt: '2026-10-14T00:00:00.000Z',
    wallMs: 1000,
    phases: { candidate: 1000 },
    exit,
    pins,
    results,
  };
}

const pass = (name) => ({ test: name, status: 'pass', baseline: null, retry: null, log: '' });
const regression = (name, log) => ({
  test: name,
  status: 'fail',
  baseline: 'pass',
  retry: 'fail',
  log,
});

function report(found, run = {}, expected = ['rest']) {
  return merge({
    run: { id: 'canary', overrides: ['@ai-ecoverse/slicc-kernel@1.86.0'], expect: [], ...run },
    biosRef: 'f'.repeat(40),
    runner: 'ubuntu-latest',
    url: '',
    found,
    expected,
  });
}

test('a shard whose files all pass is green only if it also exited 0', () => {
  assert.equal(report([shard(0, [pass('a'), pass('b')])]).ok, true);
  const torn = report([shard(1, [pass('a'), pass('b')])]);
  assert.equal(torn.ok, false);
  assert.deepEqual(torn.unexplainedExits, [{ shard: 'rest', exit: 1 }]);
  assert.match(markdown(torn), /\*\*rest\*\* exited 1 with no failing test/);
  assert.equal(report([shard('SIGKILL', [pass('a')])]).ok, false);
});

test('a nonzero exit that a failing test explains is judged by the verdicts', () => {
  const found = [shard(1, [pass('a'), regression('wasm-grep · grep --version', 'rc=70')])];
  assert.equal(report(found).ok, false);
  const expected = report(found, { expect: [{ test: 'wasm-grep · ', log: 'rc=70' }] });
  assert.equal(expected.ok, true);
  assert.deepEqual(expected.unexplainedExits, []);
});

test('a missing shard turns the canary red', () => {
  const found = [shard(0, [pass('a')])];
  assert.equal(report(found, {}, ['rest', 'follow-chat']).ok, false);
});
