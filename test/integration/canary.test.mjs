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

test('two canaries in one caller run name their artifacts apart, and a report reads only its own shards', async () => {
  const { plan, prefixOf } = await import('../../scripts/canary/plan.mjs');
  const { shards } = await import('../../scripts/canary/report.mjs');
  const sha256 = 'f'.repeat(64);
  const candidate = { package: CDP, artifact: 'packed', run: '7', sha256 };
  const base = await plan('workflow_call', { overrides: '["@ai-ecoverse/slicc-cdp@1.25.1"]' });
  const tried = await plan('workflow_call', { candidate, repo: 'ai-ecoverse/slicc-cdp' });
  assert.equal(base.prefix, 'base-');
  assert.equal(tried.prefix, 'candidate-');
  assert.equal(
    (await plan('workflow_call', { candidate, repo: 'o/r', label: 'cdp-1.27.0' })).prefix,
    'cdp-1.27.0-'
  );
  assert.equal((await plan('workflow_dispatch', { candidate, repo: 'o/r' })).prefix, '');
  assert.equal(prefixOf('', { called: false }), '');
  assert.throws(() => prefixOf('a/b'), /label/);
  assert.throws(() => prefixOf('x'.repeat(41)), /label/);

  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'canary-prefix-'));
  for (const [prefix, shard] of [
    ['base-', 'cdp'],
    ['candidate-', 'cdp'],
    ['candidate-', 'guard'],
  ]) {
    const at = join(dir, `${prefix}canary-shard-canary-${shard}`);
    await mkdir(at, { recursive: true });
    await writeFile(join(at, 'shard.json'), JSON.stringify({ shard, prefix }));
  }
  assert.deepEqual(
    (await shards(dir, 'canary', 'candidate-')).map(({ shard, prefix }) => `${prefix}${shard}`),
    ['candidate-cdp', 'candidate-guard']
  );
  assert.deepEqual(
    (await shards(dir, 'canary', 'base-')).map(({ shard }) => shard),
    ['cdp']
  );
  await rm(dir, { recursive: true });
});

test('the canary workflow checks out without credentials, keeps the tools off 9222-9229, runs a caller’s candidate on GitHub-hosted runners and prefixes every artifact', async () => {
  const { readFile } = await import('node:fs/promises');
  const yml = await readFile(
    new URL('../../.github/workflows/canary.yml', import.meta.url),
    'utf8'
  );
  const checkouts = yml
    .split(/\n(?=\s+- uses: )/)
    .filter((step) => /uses: actions\/checkout@/.test(step));
  assert.equal(checkouts.length, 4);
  for (const step of checkouts) assert.match(step, /persist-credentials: false/);
  assert.match(yml, /\nenv:\n {2}SLICC_CDP_PORTS: '9300-9309'\n/);
  const direct =
    "startsWith(github.workflow_ref, 'ai-ecoverse/slicc-bios/.github/workflows/canary.yml@')";
  const shard = yml.slice(yml.indexOf('\n  shard:'), yml.indexOf('\n  report:'));
  const runsOn = shard.match(/\n {4}runs-on: (.*)/)[1];
  assert.ok(runsOn.startsWith(`\${{ (${direct} && `), runsOn);
  assert.ok(runsOn.endsWith("|| 'ubuntu-latest' }}"), runsOn);
  assert.match(
    yml,
    new RegExp(`CANARY_RUNNER: \\$\\{\\{ \\(${direct.replace(/[().'/@]/g, '\\$&')} && `)
  );
  const names = [...yml.matchAll(/\n {10}(name|pattern): (.*)/g)].filter(
    ([, , value]) => /canary/.test(value) && !/^\$\{\{ matrix\.job\.candidate/.test(value)
  );
  assert.ok(names.length >= 6, `${names.length} artifact names`);
  for (const [, , value] of names) {
    assert.match(value, /^\$\{\{ (needs\.plan|steps\.plan)\.outputs\.prefix \}\}canary/, value);
  }
  assert.match(yml, /cancel-in-progress: \$\{\{ startsWith\(/);
});

test('a shard passes only with a test summary, no failure or cancellation, at least one passing test, and the verdict lines its files owe', async () => {
  const { shardVerdict } = await import('../../scripts/ci/verdict.mjs');
  const tally = (pass, fail = 0, cancelled = 0) =>
    `✔ a\nℹ tests ${pass + fail + cancelled}\nℹ suites 0\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled ${cancelled}\nℹ skipped 0\nℹ todo 0\n`;
  assert.deepEqual(shardVerdict('rest', tally(4)), { ok: true, line: 'shard rest: PASS 4 tests' });
  assert.deepEqual(shardVerdict('rest', ''), {
    ok: false,
    line: 'shard rest: FAIL no test summary',
  });
  assert.deepEqual(shardVerdict('rest', tally(0)), {
    ok: false,
    line: 'shard rest: FAIL 0 tests passed',
  });
  assert.deepEqual(shardVerdict('rest', tally(3, 1)), {
    ok: false,
    line: 'shard rest: FAIL 1 failed',
  });
  assert.deepEqual(shardVerdict('rest', tally(3, 0, 2)), {
    ok: false,
    line: 'shard rest: FAIL 2 cancelled',
  });
  assert.deepEqual(shardVerdict('rest', `\u001b[34m${tally(2)}\u001b[39m`).ok, true);
  const pins = ['test/integration/pins.test.mjs'];
  assert.deepEqual(shardVerdict('rest', tally(6), pins), {
    ok: false,
    line: 'shard rest: FAIL pins.test.mjs printed no verdict line',
  });
  assert.equal(shardVerdict('rest', `ℹ pins: PASS 46 packages\n${tally(6)}`, pins).ok, true);
});

test('ci / test fails for a shard with no verdict, a failing verdict, or a cancelled or timed-out job', async () => {
  const { shardsVerdict } = await import('../../scripts/ci/verdict.mjs');
  const pass = ['shard a: PASS 3 tests', 'shard b: PASS 1 tests'];
  const ok = { lint: 'success', integration: 'success' };
  assert.deepEqual(shardsVerdict(['a', 'b'], pass, ok), { ok: true, line: 'ci: PASS 2 shards' });
  assert.deepEqual(shardsVerdict(['a', 'b'], pass.slice(0, 1), ok), {
    ok: false,
    line: 'ci: FAIL b: no verdict',
  });
  assert.deepEqual(shardsVerdict(['a', 'b'], [pass[0], 'shard b: FAIL 0 tests passed'], ok), {
    ok: false,
    line: 'ci: FAIL b: FAIL 0 tests passed',
  });
  assert.deepEqual(shardsVerdict(['a', 'b'], pass, { lint: 'success', integration: 'cancelled' }), {
    ok: false,
    line: 'ci: FAIL integration: cancelled',
  });
  assert.equal(shardsVerdict(['a', 'b'], pass, { lint: 'success', integration: '' }).ok, false);
  assert.equal(shardsVerdict([], [], ok).ok, false);
});

test('a release says which tag it made, or that nothing was releasable, and publishing names the version npm has', async () => {
  const { releaseVerdict, publishVerdict } = await import('../../scripts/ci/verdict.mjs');
  assert.deepEqual(releaseVerdict('', 'v1.84.0'), { ok: true, line: 'release: v1.84.0' });
  assert.deepEqual(
    releaseVerdict(
      '[semantic-release] Found git tag v1.83.2 associated with version 1.83.2 on branch main\n[semantic-release] There are no relevant changes, so no new version is released.',
      ''
    ),
    { ok: true, line: 'release: NONE no releasable commits since v1.83.2' }
  );
  assert.equal(releaseVerdict('', '').ok, false);
  assert.equal(releaseVerdict('[semantic-release] something else', '').ok, false);
  assert.deepEqual(publishVerdict('@ai-ecoverse/slicc-bios', '1.84.0', '1.84.0', false), {
    ok: true,
    line: 'published: @ai-ecoverse/slicc-bios@1.84.0',
  });
  assert.equal(publishVerdict('@ai-ecoverse/slicc-bios', '1.84.0', '', false).ok, false);
});

test('the canary report names a verdict, and zero tests or a missing shard is a fail', async () => {
  const { verdictLine } = await import('../../scripts/canary/report.mjs');
  const counts = (pass, more = {}) => ({
    pass,
    skip: 0,
    fail: 0,
    regression: 0,
    both: 0,
    flaky: 0,
    ...more,
  });
  assert.deepEqual(verdictLine({ ok: true, run: 'canary', counts: counts(12) }), {
    ok: true,
    line: 'canary canary: PASS 12 tests',
  });
  assert.deepEqual(verdictLine({ ok: true, run: 'canary', counts: counts(0) }), {
    ok: false,
    line: 'canary canary: FAIL 0 tests ran',
  });
  assert.deepEqual(
    verdictLine({
      ok: false,
      run: 'r',
      counts: counts(3, { regression: 1 }),
      missingShards: ['guard'],
    }),
    { ok: false, line: 'canary r: FAIL 1 regression, missing guard' }
  );
});

test('every gate in the workflows prints a verdict and its caller fails without it', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (name) =>
    readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
  const ci = await read('ci.yml');
  assert.match(ci, /run: node scripts\/ci\/shard\.mjs --name "\$SHARD" --items "\$ITEMS"/);
  const job = ci.slice(ci.indexOf('\n  ci:'));
  assert.match(job, /^ {4}needs: \[plan, lint, integration\]$/m);
  assert.match(job, /^ {4}if: always\(\)$/m);
  assert.match(job, /SHARDS: \$\{\{ needs\.plan\.outputs\.shards \}\}/);
  assert.match(
    job,
    /scripts\/ci\/verdict\.mjs shards --dir artifacts\/verdicts --expect "\$SHARDS" --results "\{\\"plan\\":\\"\$PLAN\\"/
  );
  const release = await read('release.yml');
  assert.match(release, /scripts\/ci\/verdict\.mjs release --log/);
  assert.match(release, /scripts\/ci\/verdict\.mjs publish /);
  assert.doesNotMatch(release, /npm already has \$version"\n\s+exit 0/);
  const canary = await read('canary.yml');
  assert.match(canary, /canary: FAIL the report wrote no verdict/);
});
