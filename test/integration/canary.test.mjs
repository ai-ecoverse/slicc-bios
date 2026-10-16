import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown, merge } from '../../scripts/canary/report.mjs';
import { atLeast, enforceNote, kernelCalls } from '../../scripts/canary/users.mjs';

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

test('only the top-level users option of the createKernel call counts', () => {
  const nested = [
    'createKernel({',
    '  root,',
    "  network: { users: 'enforce', transport },",
    "  env: { NOTE: 'users: off, ...users' },",
    "  hooks: [{ users: 'report' }],",
    '});',
  ].join('\n');
  assert.deepEqual(kernelCalls(nested), [{ line: 1, users: null }]);
  assert.deepEqual(kernelCalls("createKernel({ network: { users: 'off' }, users: 'report' })"), [
    { line: 1, users: 'report' },
  ]);
  assert.deepEqual(kernelCalls("createKernel({ 'users': 'off' })"), [{ line: 1, users: 'off' }]);
  assert.deepEqual(kernelCalls('createKernel(options)'), [{ line: 1, users: 'dynamic' }]);
  assert.match(enforceNote(kernel('1.86.0'), scan(nested)), /no users mode/);
});

test('a prerelease of 1.78.0 is below 1.78.0, and gets no enforce note', () => {
  assert.equal(atLeast('1.78.0-rc.1', '1.78.0'), false);
  assert.equal(atLeast('1.78.0', '1.78.0'), true);
  assert.equal(atLeast('1.78.1-rc.1', '1.78.0'), true);
  assert.equal(atLeast('1.77.9', '1.78.0'), false);
  assert.equal(enforceNote(kernel('1.78.0-rc.1'), scan(old)), null);
  assert.notEqual(enforceNote(kernel('1.78.0'), scan(old)), null);
});

const CDP = '@ai-ecoverse/slicc-cdp';

async function packCandidate(version, dir) {
  const { execFile } = await import('node:child_process');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { promisify } = await import('node:util');
  const source = join(dir, 'source');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ name: CDP, version, type: 'module', main: 'src/index.js' })
  );
  await writeFile(join(source, 'src/index.js'), 'export const candidate = true;\n');
  const { stdout } = await promisify(execFile)('npm', ['pack', '--pack-destination', dir], {
    cwd: source,
  });
  return join(dir, stdout.trim().split('\n').at(-1));
}

async function scratch() {
  const { cp, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'canary-test-'));
  await cp(new URL('../../src/packages/', import.meta.url), join(dir, 'packages'), {
    recursive: true,
    filter: (path) => !path.includes('node_modules'),
  });
  return dir;
}

test('a candidate artifact whose sha256 is not the one named is refused before it is read', async () => {
  const { rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { artifactPackage, overridePins } = await import('../../scripts/canary/override-pins.mjs');
  const dir = await scratch();
  try {
    const file = await packCandidate('1.25.1-pr.1.1', dir);
    await assert.rejects(
      artifactPackage({ file, sha256: 'b'.repeat(64), package: CDP, run: '1', artifact: 'x' }),
      /its sha256 is [0-9a-f]{64}, not b{64}; refusing it/
    );
    const junk = join(dir, 'junk.tgz');
    await writeFile(junk, 'not a tarball');
    await assert.rejects(
      artifactPackage({ file: junk, sha256: 'c'.repeat(64), package: CDP }),
      /refusing it/
    );
    await assert.rejects(
      overridePins([], {
        out: join(dir, 'pins.json'),
        packages: join(dir, 'packages'),
        cdn: join(dir, 'cdn'),
        artifacts: [{ file, sha256: 'b'.repeat(64), package: CDP }],
      }),
      /refusing it/
    );
    await assert.rejects(artifactPackage({ file, sha256: 'short', package: CDP }), /64 hex digits/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a candidate artifact replaces the package in every pin and lock, and the harness serves its bytes', async () => {
  const { createHash } = await import('node:crypto');
  const { readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { artifactPackage, findPacked, overridePins } = await import(
    '../../scripts/canary/override-pins.mjs'
  );
  const dir = await scratch();
  try {
    const file = await packCandidate('1.25.1-pr.7.3', dir);
    assert.equal(await findPacked(dir, CDP), file);
    const bytes = await readFile(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    await assert.rejects(
      artifactPackage({ file, sha256, package: '@ai-ecoverse/slicc-kernel' }),
      /is @ai-ecoverse\/slicc-cdp, not @ai-ecoverse\/slicc-kernel/
    );
    const packages = join(dir, 'packages');
    const result = await overridePins([], {
      out: join(dir, 'pins.json'),
      packages,
      cdn: join(dir, 'cdn'),
      artifacts: [
        {
          file,
          sha256,
          package: CDP,
          repo: 'ai-ecoverse/slicc-cdp',
          run: '42',
          artifact: 'packed',
        },
      ],
    });
    const manifest = JSON.parse(await readFile(join(packages, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies[CDP], '1.25.1-pr.7.3');
    const lock = JSON.parse(await readFile(join(packages, 'package-lock.json'), 'utf8'));
    const entry = lock.packages[`node_modules/${CDP}`];
    assert.equal(entry.version, '1.25.1-pr.7.3');
    assert.equal(entry.integrity, integrity);
    assert.equal(
      entry.resolved,
      'https://registry.npmjs.org/@ai-ecoverse/slicc-cdp/-/slicc-cdp-1.25.1-pr.7.3.tgz'
    );
    const pnpm = await readFile(join(packages, 'pnpm-lock.yaml'), 'utf8');
    assert.match(
      pnpm,
      new RegExp(
        `'@ai-ecoverse/slicc-cdp@1.25.1-pr.7.3':\\n {4}resolution: \\{integrity: ${integrity.replace(/[+/]/g, '\\$&')}\\}`
      )
    );
    assert.doesNotMatch(pnpm + JSON.stringify(lock), /127\.0\.0\.1/);
    const served = await readFile(
      join(dir, 'cdn/registry.npmjs.org/@ai-ecoverse/slicc-cdp/-/slicc-cdp-1.25.1-pr.7.3.tgz')
    );
    assert.equal(createHash('sha256').update(served).digest('hex'), sha256);
    assert.deepEqual(result.candidates[`${CDP}@1.25.1-pr.7.3`].source, {
      repo: 'ai-ecoverse/slicc-cdp',
      run: '42',
      artifact: 'packed',
    });
    assert.equal(result.candidates[`${CDP}@1.25.1-pr.7.3`].via, 'artifact');
    const shown = report([{ ...shard(0, [pass('a')]), pins: { ...result, held: [] } }], {
      overrides: [],
    });
    assert.match(
      markdown(shown),
      /\| @ai-ecoverse\/slicc-cdp@1\.25\.1-pr\.7\.3 \| candidate \(artifact 42\/packed, sha256 [0-9a-f]{64}\) \| artifact \|/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repeated runs: always failing only with the candidate is a regression, failing on both is both, anything mixed is flaky', async () => {
  const { classify } = await import('../../scripts/canary/report.mjs');
  assert.equal(classify(['fail', 'fail', 'fail'], ['pass', 'pass', 'pass'], true), 'regression');
  assert.equal(classify(['fail', 'fail', 'fail'], ['fail', 'fail', 'fail'], true), 'both');
  assert.equal(classify(['fail', 'pass', 'fail'], ['pass', 'pass', 'pass'], true), 'flaky');
  assert.equal(classify(['fail', 'fail', 'fail'], ['fail', 'pass', 'pass'], true), 'flaky');
  assert.equal(classify(['pass', 'pass', 'pass'], [], true), 'pass');
  assert.equal(classify(['skip', 'skip'], [], true), 'skip');
  assert.equal(classify(['fail', 'pass'], [], false), 'fail');
  const repeated = (name, runs, baselines) => ({
    test: name,
    status: runs.includes('fail') ? 'fail' : 'pass',
    baseline: baselines[0] ?? null,
    retry: null,
    runs,
    baselines,
    log: runs.includes('fail') ? `${name} broke` : '',
  });
  const found = [
    shard(1, [
      repeated('steady', ['pass', 'pass', 'pass'], []),
      repeated('broken', ['fail', 'fail', 'fail'], ['pass', 'pass', 'pass']),
      repeated('old', ['fail', 'fail', 'fail'], ['fail', 'fail', 'fail']),
      repeated('loaded', ['pass', 'fail', 'pass'], ['pass', 'pass', 'pass']),
    ]),
  ];
  const merged = report(found, { repeat: 3, strict: false });
  assert.deepEqual(
    merged.results.map(({ test, verdict, failed }) => [
      test,
      verdict,
      failed?.candidate,
      failed?.baseline,
    ]),
    [
      ['steady', 'pass', '0/3', '0/0'],
      ['broken', 'regression', '3/3', '0/3'],
      ['old', 'both', '3/3', '3/3'],
      ['loaded', 'flaky', '1/3', '0/3'],
    ]
  );
  assert.deepEqual(merged.counts, { pass: 1, skip: 0, fail: 0, regression: 1, both: 1, flaky: 1 });
  assert.equal(merged.repeat, 3);
  const { summary } = await import('../../scripts/canary/report.mjs');
  const result = summary(merged, { name: 'canary', url: 'https://example.test/a' });
  assert.deepEqual(
    [result.regressions, result.both, result.flaky].map((list) => list.map(({ test }) => test)),
    [['broken'], ['old'], ['loaded']]
  );
  assert.deepEqual(result.flaky[0].failed, { candidate: '1/3', baseline: '0/3' });
  assert.deepEqual(result.missingShards, []);
  assert.deepEqual(result.artifact, { name: 'canary', url: 'https://example.test/a' });
  assert.match(markdown(merged), /each test 3 times/);
  assert.match(markdown(merged), /\| loaded \| rest \| 1\/3 vs 0\/3 \|/);
});

test('a candidate input needs its package, artifact, run and sha256, and repeat stays between 1 and 10', async () => {
  const { candidateOf, repeatOf } = await import('../../scripts/canary/plan.mjs');
  assert.equal(candidateOf({}), null);
  const sha256 = 'd'.repeat(64);
  assert.deepEqual(
    candidateOf({ package: CDP, artifact: 'packed', run: '123', sha256 }, 'ai-ecoverse/slicc-cdp'),
    { package: CDP, artifact: 'packed', run: '123', sha256, repo: 'ai-ecoverse/slicc-cdp' }
  );
  assert.throws(() => candidateOf({ package: CDP, artifact: 'packed', run: '123' }), /needs/);
  assert.throws(
    () => candidateOf({ package: 'slicc-cdp', artifact: 'a', run: '1', sha256 }, 'o/r'),
    /scoped/
  );
  assert.throws(
    () => candidateOf({ package: CDP, artifact: 'a', run: 'x', sha256 }, 'o/r'),
    /run id/
  );
  assert.throws(
    () => candidateOf({ package: CDP, artifact: 'a', run: '1', sha256: 'e' }, 'o/r'),
    /64 hex/
  );
  assert.equal(repeatOf(''), 1);
  assert.equal(repeatOf(3), 3);
  assert.throws(() => repeatOf('11'), /1 to 10/);
  assert.throws(() => repeatOf('0'), /1 to 10/);
});
