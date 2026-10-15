import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown, merge } from '../../scripts/canary/report.mjs';
import { enforceNote, kernelCalls } from '../../scripts/canary/users.mjs';

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

const old = [
  'const start = () => createKernel({ root, network: { transport }, media: false });',
  'kernel = await createKernel({',
  '  root,',
  '  network: { transport, uplink: exits.uplink },',
  '  ...folders.options,',
  '});',
].join('\n');
const off = old
  .replace('{ root,', "{ root, users: 'off',")
  .replace('  root,', "  root,\n  users: 'off',");
const kernel = (version) => [
  { name: '@ai-ecoverse/slicc-kernel', version, sha256: 'a'.repeat(64) },
];
const scan = (text) => kernelCalls(text).map((call) => ({ file: 'src/seed/os.js', ...call }));

test('the scan finds every createKernel call and the users mode it passes', () => {
  assert.deepEqual(kernelCalls(old), [
    { line: 1, users: null },
    { line: 2, users: null },
  ]);
  assert.deepEqual(kernelCalls(off), [
    { line: 1, users: 'off' },
    { line: 2, users: 'off' },
  ]);
  assert.deepEqual(kernelCalls('createKernel({ root, users })'), [{ line: 1, users: 'dynamic' }]);
  assert.deepEqual(kernelCalls('createKernel({ root, ...kernelUsers(mode) })'), [
    { line: 1, users: 'dynamic' },
  ]);
});

test('a kernel from 1.78.0 on a ref with no users mode gets the enforce note', () => {
  const note = enforceNote(kernel('1.86.0'), scan(old));
  assert.match(note, /no users mode \(src\/seed\/os\.js:1, src\/seed\/os\.js:2\)/);
  assert.match(note, /slicc-kernel 1\.86\.0 runs under its default, enforce/);
  assert.match(note, /#495/);
  assert.equal(enforceNote(kernel('1.78.0'), scan(old)) === null, false);
  assert.equal(enforceNote(kernel('1.77.2'), scan(old)), null);
  assert.equal(enforceNote(kernel('1.86.0'), scan(off)), null);
  assert.equal(enforceNote([], scan(old)), null);
  const found = [
    {
      ...shard(0, [pass('a')]),
      pins: { ...pins, overrides: kernel('1.81.0') },
      kernels: scan(old),
    },
  ];
  const shown = report(found);
  assert.equal(shown.notes.length, 1);
  assert.match(
    markdown(shown),
    /> \*\*Note:\*\* This bios ref creates its kernel with no users mode/
  );
  assert.deepEqual(report([shard(0, [pass('a')])]).notes, []);
});
