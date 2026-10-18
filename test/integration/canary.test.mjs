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

const keyOf = (name) => `test/integration/x.test.mjs › ${name}`;
const pass = (name) => ({
  test: name,
  key: keyOf(name),
  status: 'pass',
  baseline: null,
  retry: null,
  log: '',
});
const regression = (name, log) => ({
  test: name,
  key: keyOf(name),
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
    key: keyOf(name),
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
  const bound = { id: '991', digest: 'E'.repeat(64) };
  assert.deepEqual(
    candidateOf(
      { package: CDP, artifact: 'packed', run: '123', sha256, ...bound },
      'ai-ecoverse/slicc-cdp'
    ),
    {
      package: CDP,
      artifact: 'packed',
      run: '123',
      sha256,
      repo: 'ai-ecoverse/slicc-cdp',
      id: '991',
      digest: 'e'.repeat(64),
      binding: 'strict',
    }
  );
  assert.throws(() => candidateOf({ package: CDP, artifact: 'packed', run: '123' }), /needs/);
  assert.throws(() => candidateOf({ id: '991', digest: 'e'.repeat(64) }, 'o/r'), /needs/);
  assert.throws(
    () => candidateOf({ package: 'slicc-cdp', artifact: 'a', run: '1', sha256, ...bound }, 'o/r'),
    /scoped/
  );
  assert.throws(
    () => candidateOf({ package: CDP, artifact: 'a', run: 'x', sha256, ...bound }, 'o/r'),
    /run id/
  );
  assert.throws(
    () => candidateOf({ package: CDP, artifact: 'a', run: '1', sha256: 'e', ...bound }, 'o/r'),
    /64 hex/
  );
  assert.equal(repeatOf(''), 1);
  assert.equal(repeatOf(3), 3);
  assert.throws(() => repeatOf('11'), /1 to 10/);
  assert.throws(() => repeatOf('0'), /1 to 10/);
});

test('two canaries in one caller run name their artifacts apart, and a report reads only its own shards', async () => {
  const { plan, prefixOf } = await import('../../scripts/canary/plan.mjs');
  const { found, readShards } = await import('../../scripts/canary/report.mjs');
  const sha256 = 'f'.repeat(64);
  const candidate = {
    package: CDP,
    artifact: 'packed',
    run: '7',
    sha256,
    id: '70',
    digest: 'a'.repeat(64),
  };
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
  const layout = {
    'base-': ['cdp'],
    'candidate-': ['cdp', 'guard'],
  };
  for (const [prefix, list] of Object.entries(layout)) {
    for (const shard of list) {
      const at = join(dir, prefix, `${prefix}canary-shard-canary-${shard}`);
      await mkdir(at, { recursive: true });
      await writeFile(join(at, 'shard.json'), JSON.stringify({ shard, prefix }));
    }
  }
  const read = async (prefix) => {
    const verified = layout[prefix].map((shard) => ({
      run: 'canary',
      shard,
      name: `${prefix}canary-shard-canary-${shard}`,
    }));
    const { docs, refused } = await readShards(join(dir, prefix), verified);
    assert.deepEqual(refused, []);
    return found(docs, { id: 'canary', shards: layout[prefix] });
  };
  assert.deepEqual(
    (await read('candidate-')).map(({ shard, prefix }) => `${prefix}${shard}`),
    ['candidate-cdp', 'candidate-guard']
  );
  assert.deepEqual(
    (await read('base-')).map(({ shard }) => shard),
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
  assert.ok(names.length >= 4, `${names.length} artifact names`);
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
  assert.deepEqual(
    verdictLine({ ok: false, run: 'canary', counts: counts(0), missingShards: ['guard'] }),
    { ok: false, line: 'canary canary: FAIL 0 tests ran, missing guard' }
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

const BIND = new URL('../../scripts/canary/bind.mjs', import.meta.url);
const REPORT = new URL('../../scripts/canary/report.mjs', import.meta.url);
const ONE = '1'.repeat(64);
const TWO = '2'.repeat(64);

function meta(id, name, run, repositoryId, digest, more = {}) {
  return {
    id: Number(id),
    name,
    digest: `sha256:${digest}`,
    expired: false,
    workflow_run: { id: Number(run), repository_id: repositoryId, head_repository_id: 999 },
    ...more,
  };
}

async function fakeApi(repos, artifacts) {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization ?? '' });
    const repo = request.url.match(/^\/repos\/([^/]+\/[^/]+)$/);
    const artifact = request.url.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/artifacts\/(\d+)$/);
    let body = null;
    if (repo && repos[repo[1]]) body = { id: repos[repo[1]], full_name: repo[1] };
    if (artifact) body = artifacts[`${artifact[1]}#${artifact[2]}`] ?? null;
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? { message: 'Not Found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    api: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function cli(script, args, extra = {}) {
  const { execFile } = await import('node:child_process');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { promisify } = await import('node:util');
  const dir = await mkdtemp(join(tmpdir(), 'canary-cli-'));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: tmpdir(),
    GH_TOKEN: 'test-token',
    GITHUB_OUTPUT: join(dir, 'out'),
    ...extra,
  };
  let code = 0;
  let stdout = '';
  try {
    ({ stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(script), ...args], {
      env,
      cwd: extra.CWD ?? process.cwd(),
    }));
  } catch (error) {
    code = error.code;
    stdout = error.stdout;
  }
  const text = await readFile(join(dir, 'out'), 'utf8').catch(() => '');
  await rm(dir, { recursive: true, force: true });
  const outputs = Object.fromEntries(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
  return { code, stdout, outputs };
}

test('the report job’s upload step returns the canary artifact’s id and digest, and the call exposes those as artifact-id, artifact-digest and the report row of artifacts', async () => {
  const { readFile } = await import('node:fs/promises');
  const yml = await readFile(
    new URL('../../.github/workflows/canary.yml', import.meta.url),
    'utf8'
  );
  for (const key of ['artifact-id', 'artifact-digest', 'artifacts']) {
    assert.match(
      yml,
      new RegExp(
        `\\n {6}${key}:\\n {8}description: .*\\n {8}value: \\$\\{\\{ jobs\\.report\\.outputs\\.${key} \\}\\}\\n`
      ),
      key
    );
  }
  const report = yml.slice(yml.indexOf('\n  report:'));
  assert.match(report, /\n {6}artifact-id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}\n/);
  assert.match(
    report,
    /\n {6}artifact-digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}\n/
  );
  assert.match(report, /\n {6}artifacts: \$\{\{ steps\.manifest\.outputs\.artifacts \}\}\n/);
  assert.match(
    report,
    /\n {6}- id: upload\n {8}uses: actions\/upload-artifact@[0-9a-f]{40}\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}with:\n {10}name: \$\{\{ needs\.plan\.outputs\.prefix \}\}canary\n/
  );
  assert.match(report, /REPORT_ID: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
  assert.match(report, /REPORT_DIGEST: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/);
  assert.match(report, /ARTIFACT_ID: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
  assert.match(report, /ARTIFACT_DIGEST: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/);
  assert.match(report, /id: process\.env\.ARTIFACT_ID \|\| ""/);
  assert.doesNotMatch(yml, /\n\s+pattern: /);

  const done = await cli(BIND, ['manifest', '--bindings', '/nonexistent/bindings.json'], {
    PREFIX: 'candidate-',
    UPLOADS: '[]',
    REPORT_ID: '9001',
    REPORT_DIGEST: 'AB'.repeat(32),
    GITHUB_RUN_ATTEMPT: '2',
  });
  assert.equal(done.code, 0, done.stdout);
  assert.deepEqual(JSON.parse(done.outputs.artifacts), [
    { role: 'report', name: 'candidate-canary', id: '9001', digest: 'ab'.repeat(32), attempt: '2' },
  ]);
  const none = await cli(BIND, ['manifest', '--bindings', '/nonexistent/bindings.json'], {
    PREFIX: 'base-',
  });
  assert.deepEqual(JSON.parse(none.outputs.artifacts), []);
  const bad = await cli(BIND, ['manifest', '--bindings', '/nonexistent/bindings.json'], {
    REPORT_ID: '9001',
    REPORT_DIGEST: 'not-a-digest',
  });
  assert.notEqual(bad.code, 0);
  assert.equal(bad.outputs.artifacts, undefined);
});

test('the manifest keeps both matrix shards’ upload ids and digests, each from its own job output, not the last job’s', async () => {
  const { readFile } = await import('node:fs/promises');
  const { MAX_JOBS } = await import('../../scripts/canary/bind.mjs');
  const { jobs } = await import('../../scripts/canary/plan.mjs');
  const yml = await readFile(
    new URL('../../.github/workflows/canary.yml', import.meta.url),
    'utf8'
  );
  const shard = yml.slice(yml.indexOf('\n  shard:'), yml.indexOf('\n  report:'));
  const declared = [
    ...shard.matchAll(/\n {6}(binding_\d+): \$\{\{ steps\.bind\.outputs\.(\S+) \}\}/g),
  ];
  assert.deepEqual(
    declared.map(([, key, value]) => [key, value]),
    Array.from({ length: MAX_JOBS }, (_, i) => [`binding_${i}`, `binding_${i}`])
  );
  assert.match(shard, /\n {10}INDEX: \$\{\{ strategy\.job-index \}\}\n/);
  assert.match(shard, /SHARD_ID: \$\{\{ steps\.shard-upload\.outputs\.artifact-id \}\}/);
  assert.match(shard, /SHARD_DIGEST: \$\{\{ steps\.shard-upload\.outputs\.artifact-digest \}\}/);
  assert.match(shard, /FILES_ID: \$\{\{ steps\.files-upload\.outputs\.artifact-id \}\}/);
  assert.match(shard, /FILES_DIGEST: \$\{\{ steps\.files-upload\.outputs\.artifact-digest \}\}/);
  assert.match(
    shard,
    /- id: shard-upload\n.*\n.*\n.*\n {10}name: \$\{\{ needs\.plan\.outputs\.prefix \}\}canary-shard-\$\{\{ matrix\.job\.run \}\}-\$\{\{ matrix\.job\.shard \}\}\n/
  );
  assert.match(
    shard,
    /- id: files-upload\n.*\n.*\n.*\n {10}name: \$\{\{ needs\.plan\.outputs\.prefix \}\}canary-files-\$\{\{ matrix\.job\.run \}\}-\$\{\{ matrix\.job\.shard \}\}\n/
  );
  const known = JSON.parse(
    await readFile(new URL('../../scripts/canary/shards.json', import.meta.url), 'utf8')
  );
  assert.ok(Object.keys(known).length <= MAX_JOBS);
  const many = Array.from({ length: MAX_JOBS + 1 }, (_, i) => `s${i}`);
  assert.throws(() => jobs([{ id: 'canary', ref: 'r', shards: many }]), /at most 16/);

  const planned = jobs([{ id: 'canary', ref: 'r', shards: ['packages-update-cdp', 'guard'] }]);
  const outputs = Object.fromEntries(
    Array.from({ length: MAX_JOBS }, (_, i) => [`binding_${i}`, ''])
  );
  const uploads = [
    ['packages-update-cdp', '101', 'A1'.repeat(32), '102', 'a2'.repeat(32)],
    ['guard', '201', 'b1'.repeat(32), '', ''],
  ];
  for (const [index, [name, shardId, shardDigest, filesId, filesDigest]] of uploads.entries()) {
    const done = await cli(BIND, ['shard'], {
      INDEX: String(index),
      RUN: 'canary',
      SHARD: name,
      PREFIX: 'candidate-',
      ATTEMPT: '1',
      SHARD_ID: shardId,
      SHARD_DIGEST: shardDigest,
      FILES_ID: filesId,
      FILES_DIGEST: filesDigest,
    });
    assert.equal(done.code, 0, done.stdout);
    assert.deepEqual(Object.keys(done.outputs), [`binding_${index}`]);
    Object.assign(outputs, done.outputs);
  }
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = 'ai-ecoverse/slicc-cdp';
  const uploaded = {
    101: ['candidate-canary-shard-canary-packages-update-cdp', 'a1'.repeat(32)],
    102: ['candidate-canary-files-canary-packages-update-cdp', 'a2'.repeat(32)],
    201: ['candidate-canary-shard-canary-guard', 'b1'.repeat(32)],
  };
  const server = await fakeApi(
    { [repo]: 7 },
    Object.fromEntries(
      Object.entries(uploaded).map(([id, [name, digest]]) => [
        `${repo}#${id}`,
        meta(id, name, 600, 7, digest),
      ])
    )
  );
  const dir = await mkdtemp(join(tmpdir(), 'canary-manifest-'));
  const bindings = join(dir, 'bindings.json');
  const api = {
    GITHUB_API_URL: server.api,
    GITHUB_RUN_ID: '600',
    GITHUB_REPOSITORY: repo,
    PREFIX: 'candidate-',
    JOBS: JSON.stringify(planned),
  };
  try {
    const bound = await cli(BIND, ['shards', '--out', bindings, '--dir', join(dir, 'shards')], {
      ...api,
      BINDINGS: JSON.stringify(outputs),
    });
    assert.equal(bound.code, 0, bound.stdout);
    assert.match(bound.stdout, /^canary bindings: PASS 2 shards, 3 artifacts$/m);
    assert.deepEqual(bound.outputs, { ids: '101,201', path: join(dir, 'shards') });
    const done = await cli(BIND, ['manifest', '--bindings', bindings], {
      PREFIX: 'candidate-',
      UPLOADS: '[]',
      REPORT_ID: '301',
      REPORT_DIGEST: 'c1'.repeat(32),
      GITHUB_RUN_ATTEMPT: '1',
    });
    assert.equal(done.code, 0, done.stdout);
    assert.deepEqual(JSON.parse(done.outputs.artifacts), [
      {
        role: 'shard',
        name: 'candidate-canary-shard-canary-packages-update-cdp',
        id: '101',
        digest: 'a1'.repeat(32),
        attempt: '1',
      },
      {
        role: 'files',
        name: 'candidate-canary-files-canary-packages-update-cdp',
        id: '102',
        digest: 'a2'.repeat(32),
        attempt: '1',
      },
      {
        role: 'shard',
        name: 'candidate-canary-shard-canary-guard',
        id: '201',
        digest: 'b1'.repeat(32),
        attempt: '1',
      },
      {
        role: 'report',
        name: 'candidate-canary',
        id: '301',
        digest: 'c1'.repeat(32),
        attempt: '1',
      },
    ]);
    const tampered = JSON.parse(outputs.binding_0);
    tampered.rows[1].digest = 'ff'.repeat(32);
    const refused = await cli(BIND, ['shards', '--out', bindings, '--dir', join(dir, 'shards')], {
      ...api,
      BINDINGS: JSON.stringify({ ...outputs, binding_0: JSON.stringify(tampered) }),
    });
    assert.match(
      refused.stdout,
      /^canary bindings: FAIL candidate-canary-files-canary-packages-update-cdp: .*refusing it$/m
    );
    const partial = await cli(BIND, ['manifest', '--bindings', bindings], { PREFIX: 'candidate-' });
    assert.deepEqual(
      JSON.parse(partial.outputs.artifacts).map(({ name }) => name),
      ['candidate-canary-shard-canary-packages-update-cdp', 'candidate-canary-shard-canary-guard']
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
  const proof = await cli(BIND, ['manifest', '--bindings', '/nonexistent/bindings.json'], {
    PREFIX: '',
    UPLOADS: JSON.stringify([{ name: 'canary-candidate-artifact', path: 'x' }]),
    PROOF_ID: '55',
    PROOF_DIGEST: ONE,
    PLAN_ATTEMPT: '1',
  });
  assert.deepEqual(JSON.parse(proof.outputs.artifacts), [
    { role: 'plan', name: 'canary-candidate-artifact', id: '55', digest: ONE, attempt: '1' },
  ]);
});

test('a candidate artifact whose id, name, repository, run or zip digest is not the bound one is refused before it is downloaded, and a strict call without a binding is refused', async () => {
  const { candidateOf, plan } = await import('../../scripts/canary/plan.mjs');
  const { bindCandidate, candidateBinding } = await import('../../scripts/canary/bind.mjs');
  const sha256 = 'f'.repeat(64);
  const given = { package: CDP, artifact: 'cdp-pack', run: '500', sha256 };
  assert.throws(
    () => candidateOf(given, 'ai-ecoverse/slicc-cdp'),
    /a strict candidate needs candidate-artifact-id and candidate-artifact-digest .*refusing it/
  );
  assert.throws(() => candidateOf({ ...given, binding: 'strict' }, 'o/r'), /strict candidate/);
  assert.throws(() => candidateOf({ ...given, id: '42' }, 'o/r'), /go together/);
  assert.throws(() => candidateOf({ ...given, digest: ONE }, 'o/r'), /go together/);
  assert.throws(() => candidateOf({ ...given, id: 'x', digest: ONE }, 'o/r'), /not an artifact id/);
  assert.throws(() => candidateOf({ ...given, id: '42', digest: 'zz' }, 'o/r'), /not a sha256/);
  await assert.rejects(
    plan('workflow_call', { candidate: given, repo: 'ai-ecoverse/slicc-cdp' }),
    /strict candidate/
  );
  await assert.rejects(
    plan('workflow_call', { candidate: { ...given, binding: 'plan' }, repo: 'o/r' }),
    /strict or legacy/
  );
  assert.equal((await plan('workflow_call', {})).runs[0].candidate, null);
  const legacy = candidateOf({ ...given, binding: 'legacy' }, 'o/r');
  assert.equal(legacy.binding, 'legacy');
  assert.equal(legacy.id, undefined);
  const candidate = candidateOf(
    { ...given, id: '42', digest: `sha256:${ONE}` },
    'ai-ecoverse/slicc-cdp'
  );
  assert.equal(candidate.digest, ONE);

  const cdp = 'ai-ecoverse/slicc-cdp';
  const server = await fakeApi(
    { [cdp]: 7 },
    {
      [`${cdp}#42`]: meta(42, 'cdp-pack', 500, 7, ONE),
      [`${cdp}#43`]: meta(43, 'cdp-pack-other', 500, 7, ONE),
      [`${cdp}#44`]: meta(44, 'cdp-pack', 501, 7, ONE),
      [`${cdp}#45`]: meta(45, 'cdp-pack', 500, 8, ONE),
      [`${cdp}#46`]: meta(46, 'cdp-pack', 500, 7, ONE, { expired: true }),
      [`${cdp}#47`]: meta(47, 'cdp-pack', 500, 7, TWO),
      [`${cdp}#48`]: meta(49, 'cdp-pack', 500, 7, ONE),
    }
  );
  try {
    const bound = await bindCandidate(candidate, { api: server.api });
    assert.equal(bound.id, '42');
    assert.equal(bound.name, '');
    assert.match(
      bound.line,
      new RegExp(`^canary candidate: PASS artifact 42 cdp-pack .*sha256:${ONE}$`)
    );
    assert.ok(server.seen.every(({ auth }) => auth === 'Bearer test-token' || auth === ''));
    const refusals = [
      ['43', { digest: ONE }, /its name is cdp-pack-other/],
      ['44', { digest: ONE }, /it is from run 501, not 500/],
      ['45', { digest: ONE }, /it is from repository 8, not 7/],
      ['46', { digest: ONE }, /it has expired/],
      ['47', { digest: ONE }, new RegExp(`its digest is sha256:${TWO}, not sha256:${ONE}`)],
      ['42', { digest: TWO }, new RegExp(`its digest is sha256:${ONE}, not sha256:${TWO}`)],
      ['48', { digest: ONE }, /its id is 49, not 48/],
      ['99', { digest: ONE }, /404/],
    ];
    for (const [id, more, pattern] of refusals) {
      await assert.rejects(
        bindCandidate({ ...candidate, id, ...more }, { api: server.api }),
        pattern
      );
    }
    await assert.rejects(
      bindCandidate({ ...candidate, repo: 'evil/fork' }, { api: server.api }),
      /404/
    );
    const unbound = { ...candidate, id: undefined, digest: undefined };
    await assert.rejects(bindCandidate(unbound, { api: server.api }), /strict candidate/);
    const calls = server.seen.length;
    assert.deepEqual(await bindCandidate(legacy, { api: server.api }), {
      id: '',
      name: 'cdp-pack',
      line: `canary candidate: PASS legacy binding, cdp-pack by name from o/r run 500, sha256 ${sha256} checked after download`,
    });
    assert.equal(server.seen.length, calls);

    const planRows = [{ role: 'plan', name: 'canary-candidate-artifact', id: '5', digest: ONE }];
    const proof = { artifact: 'canary-candidate-artifact', binding: 'plan' };
    assert.deepEqual(candidateBinding(proof, planRows), { id: '5', digest: ONE });
    assert.throws(
      () => candidateBinding({ ...proof, artifact: 'canary-candidate-other' }, planRows),
      /uploaded no canary-candidate-other/
    );

    const env = { GITHUB_API_URL: server.api };
    const refused = await cli(BIND, ['candidate'], {
      ...env,
      CANDIDATE: JSON.stringify({ ...candidate, digest: TWO }),
    });
    assert.equal(refused.code, 1);
    assert.match(
      refused.stdout,
      /^canary candidate: FAIL artifact 42 \(cdp-pack\): .*refusing it$/m
    );
    assert.deepEqual(refused.outputs, {});
    const passed = await cli(BIND, ['candidate'], { ...env, CANDIDATE: JSON.stringify(candidate) });
    assert.equal(passed.code, 0, passed.stdout);
    assert.deepEqual(passed.outputs, { id: '42', name: '' });
  } finally {
    await server.close();
  }
  const { readFile } = await import('node:fs/promises');
  const yml = await readFile(
    new URL('../../.github/workflows/canary.yml', import.meta.url),
    'utf8'
  );
  const shard = yml.slice(yml.indexOf('\n  shard:'), yml.indexOf('\n  report:'));
  const check = shard.indexOf('run: node scripts/canary/bind.mjs candidate');
  const download = shard.indexOf('- name: The candidate artifact\n');
  assert.ok(check > 0 && check < download && download < shard.indexOf('- run: npm ci'));
  assert.match(
    shard.slice(download, download + 600),
    /artifact-ids: \$\{\{ steps\.candidate\.outputs\.id \}\}\n {10}name: \$\{\{ steps\.candidate\.outputs\.name \}\}\n[\s\S]*digest-mismatch: error/
  );
});

test('a forged shard artifact with an extra suffix, or one the API does not match to its upload step, is refused and turns the canary red', async () => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { collect, verifyShards } = await import('../../scripts/canary/bind.mjs');
  const { jobs } = await import('../../scripts/canary/plan.mjs');
  const { merge, readShards, verdictLine } = await import('../../scripts/canary/report.mjs');
  const planned = jobs([{ id: 'canary', ref: 'r', shards: ['packages-update-cdp', 'guard'] }]);
  const name = (shard) => `candidate-canary-shard-canary-${shard}`;
  const binding = (shard, id, digest, rowName = name(shard)) =>
    JSON.stringify({
      run: 'canary',
      shard,
      rows: [{ role: 'shard', name: rowName, id, digest, attempt: '1' }],
    });
  const honest = {
    binding_0: binding('packages-update-cdp', '11', ONE),
    binding_1: binding('guard', '12', TWO),
  };
  assert.deepEqual(
    collect(honest, planned, 'candidate-').shards.map(({ shard, id }) => [shard, id]),
    [
      ['packages-update-cdp', '11'],
      ['guard', '12'],
    ]
  );
  const extra = collect(
    { ...honest, binding_2: binding('guard-extra', '13', ONE) },
    planned,
    'candidate-'
  );
  assert.deepEqual(extra.refused, [
    { name: 'binding_2', reason: 'canary/guard-extra is not a planned shard' },
  ]);
  const suffixed = collect(
    { ...honest, binding_1: binding('guard', '13', ONE, `${name('guard')}-extra`) },
    planned,
    'candidate-'
  );
  assert.deepEqual(suffixed.refused, [
    { name: `${name('guard')}-extra`, reason: `its name is not ${name('guard')}` },
  ]);
  assert.deepEqual(
    suffixed.shards.map(({ shard }) => shard),
    ['packages-update-cdp']
  );

  const repo = 'ai-ecoverse/slicc-cdp';
  const server = await fakeApi(
    { [repo]: 7 },
    {
      [`${repo}#11`]: meta(11, name('packages-update-cdp'), 600, 7, ONE),
      [`${repo}#12`]: meta(12, name('guard'), 600, 7, TWO),
      [`${repo}#14`]: meta(14, name('guard'), 600, 7, ONE),
    }
  );
  const dir = await mkdtemp(join(tmpdir(), 'canary-forged-'));
  try {
    const ok = await verifyShards(
      { outputs: honest, jobs: planned, prefix: 'candidate-', run: '600', repo },
      { api: server.api }
    );
    assert.equal(ok.verdict, 'canary bindings: PASS 2 shards, 2 artifacts');
    assert.deepEqual(
      ok.verified.map(({ name: n, id }) => [n, id]),
      [
        [name('packages-update-cdp'), '11'],
        [name('guard'), '12'],
      ]
    );
    const swapped = await verifyShards(
      {
        outputs: { ...honest, binding_1: binding('guard', '14', TWO) },
        jobs: planned,
        prefix: 'candidate-',
        run: '600',
        repo,
      },
      { api: server.api }
    );
    assert.equal(swapped.ok, false);
    assert.match(
      swapped.verdict,
      /^canary bindings: FAIL candidate-canary-shard-canary-guard: .*its digest is sha256:1{64}, not sha256:2{64}; refusing it$/
    );
    const missing = await verifyShards(
      {
        outputs: { binding_0: honest.binding_0 },
        jobs: planned,
        prefix: 'candidate-',
        run: '600',
        repo,
      },
      { api: server.api }
    );
    assert.match(missing.verdict, /FAIL candidate-canary-shard-canary-guard: no binding$/);

    const shards = join(dir, 'shards');
    for (const [shard, at] of [
      ['packages-update-cdp', name('packages-update-cdp')],
      ['guard', name('guard')],
      ['guard', `${name('guard')}-extra`],
    ]) {
      await mkdir(join(shards, at), { recursive: true });
      await writeFile(
        join(shards, at, 'shard.json'),
        JSON.stringify(
          shard === 'guard' && at.endsWith('-extra') ? forgedShard() : realShard(shard)
        )
      );
    }
    const read = await readShards(shards, ok.verified);
    assert.deepEqual(read.refused, [
      { name: `${name('guard')}-extra`, reason: 'no verified binding names it' },
    ]);
    const red = merge({
      run: { id: 'canary', overrides: [], expect: [] },
      biosRef: 'f'.repeat(40),
      runner: 'ubuntu-latest',
      url: '',
      found: [...read.docs.values()],
      expected: ['packages-update-cdp', 'guard'],
      refused: read.refused,
    });
    assert.equal(red.ok, false);
    assert.equal(verdictLine(red).line, `canary canary: FAIL refused ${name('guard')}-extra`);
    const failed = await readShards(shards, ok.verified, { download: 'failure' });
    assert.equal(failed.docs.size, 0);
    assert.equal(failed.refused.length, 3);
    const wrong = await readShards(shards, [{ ...ok.verified[1], shard: 'other' }]);
    assert.match(JSON.stringify(wrong.refused), /it holds shard guard, not other/);

    await writeFile(join(dir, 'bindings.json'), JSON.stringify(ok));
    const runs = JSON.stringify([
      {
        id: 'canary',
        ref: 'f'.repeat(40),
        overrides: [],
        shards: ['packages-update-cdp', 'guard'],
        expect: [],
      },
    ]);
    const args = [
      '--dir',
      shards,
      '--runs',
      runs,
      '--out',
      join(dir, 'canary'),
      '--bindings',
      join(dir, 'bindings.json'),
      '--download',
      'success',
    ];
    const forged = await cli(REPORT, args);
    assert.equal(forged.code, 1);
    assert.equal(forged.outputs.ok, 'false');
    const result = JSON.parse(await readFile(join(dir, 'canary/result.json'), 'utf8'));
    assert.equal(result.verdict, `canary canary: FAIL refused ${name('guard')}-extra`);
    const canary = JSON.parse(await readFile(join(dir, 'canary/canary.json'), 'utf8'));
    assert.deepEqual(
      canary.results.map(({ test }) => test),
      ['real guard', 'real packages-update-cdp']
    );
    await rm(join(shards, `${name('guard')}-extra`), { recursive: true });
    const clean = await cli(REPORT, args);
    assert.equal(clean.code, 0, clean.stdout);
    assert.equal(clean.outputs.ok, 'true');
    await writeFile(join(dir, 'bindings.json'), '{}');
    const unbound = await cli(REPORT, args);
    assert.equal(unbound.code, 1);
    assert.match(
      JSON.parse(await readFile(join(dir, 'canary/result.json'), 'utf8')).verdict,
      /FAIL refused .*bindings\.json/
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function realShard(name) {
  return { ...shard(0, [pass(`real ${name}`)], name) };
}

function forgedShard() {
  return { ...shard(0, [pass('forged guard')], 'guard') };
}

test('a call the plan refuses still gets a red report that names the refusal, under its own label', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const PLAN = new URL('../../scripts/canary/plan.mjs', import.meta.url);
  const refused = await cli(PLAN, [], {
    EVENT: 'workflow_call',
    LABEL: 'candidate',
    CANDIDATE_PACKAGE: CDP,
    CANDIDATE_ARTIFACT: 'cdp-pack',
    CANDIDATE_RUN: '500',
    CANDIDATE_SHA256: 'f'.repeat(64),
    CANDIDATE_ARTIFACT_ID: '',
    CANDIDATE_ARTIFACT_DIGEST: '',
    CANDIDATE_BINDING: '',
    GITHUB_REPOSITORY: 'ai-ecoverse/slicc-cdp',
  });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /^canary plan: FAIL a strict candidate needs .*refusing it$/m);
  assert.equal(refused.outputs.prefix, 'candidate-');
  assert.equal(refused.outputs.jobs, undefined);
  const dir = await mkdtemp(join(tmpdir(), 'canary-refused-'));
  try {
    const report = await cli(
      REPORT,
      [
        '--dir',
        join(dir, 'shards'),
        '--runs',
        '',
        '--out',
        join(dir, 'canary'),
        '--bindings',
        join(dir, 'none.json'),
      ],
      { PLAN_REFUSED: refused.outputs.refused }
    );
    assert.equal(report.code, 1);
    assert.equal(report.outputs.ok, 'false');
    const result = JSON.parse(await readFile(join(dir, 'canary/result.json'), 'utf8'));
    assert.equal(result.ok, false);
    assert.match(result.verdict, /^canary: FAIL the plan refused: a strict candidate needs /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function stepsOf(yml) {
  return yml.split(/\n(?= {6}- )/).filter((step) => /^ {6}- /.test(step));
}

const field = (step, name) => step.match(new RegExp(`\\n {8,10}${name}: (.*)`))?.[1] ?? null;

test('every checkout of the canary’s own tools is the workflow’s own commit, never main, so a caller pinned to a commit runs that commit’s scripts', async () => {
  const { readFile } = await import('node:fs/promises');
  const yml = await readFile(
    new URL('../../.github/workflows/canary.yml', import.meta.url),
    'utf8'
  );
  const own = '${{ job.workflow_sha }}';
  const checkouts = stepsOf(yml).filter((step) => /uses: actions\/checkout@/.test(step));
  assert.equal(checkouts.length, 4);
  for (const step of checkouts) {
    assert.equal(field(step, 'repository'), 'ai-ecoverse/slicc-bios', step);
    assert.doesNotMatch(field(step, 'ref'), /main|github\.|needs\.|inputs\./, step);
  }
  assert.deepEqual(checkouts.map((step) => field(step, 'ref')).sort(), [
    own,
    own,
    own,
    '${{ matrix.job.ref }}',
  ]);
  const job = (name, next) => yml.slice(yml.indexOf(`\n  ${name}:`), yml.indexOf(`\n  ${next}:`));
  const plan = stepsOf(job('plan', 'shard'));
  assert.equal(field(plan[0], 'ref'), own);
  const ref = plan.find((step) => /^ {6}- id: ref\n/.test(step));
  assert.match(ref, /WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(ref, /"\$sha" != "\$WORKFLOW_SHA"/);
  assert.match(ref, /canary tools: FAIL /);
  assert.match(ref, /canary tools: PASS /);
  const decide = plan.find((step) => /^ {6}- id: plan\n/.test(step));
  assert.equal(field(decide, 'TOOLS_SHA'), '${{ steps.ref.outputs.sha }}');
  assert.equal(field(decide, 'BIOS_REF'), '${{ inputs.bios-ref }}');
  assert.equal(field(decide, 'CANDIDATE_BINDING'), '${{ inputs.candidate-binding }}');
  const shard = stepsOf(job('shard', 'report'));
  assert.equal(field(shard[0], 'ref'), '${{ matrix.job.ref }}');
  const overlay = shard.filter((step) => /\.canary-tools/.test(step));
  assert.equal(overlay.length, 2);
  for (const step of overlay) assert.equal(field(step, 'if'), 'matrix.job.ref != job.workflow_sha');
  assert.equal(field(overlay[0], 'ref'), own);
  const report = stepsOf(yml.slice(yml.indexOf('\n  report:')));
  assert.equal(field(report[0], 'ref'), own);
  const run = report.find((step) => /^ {6}- id: report\n/.test(step));
  assert.match(run, /report\.mjs .*--bindings bindings\.json --download "\$DOWNLOAD"/);
  assert.doesNotMatch(run, /--prefix/);
});

const OLD_PIN = '4025d6aabc2c06add216183064d81914a171cd64';
const OLD_RUN = '39086144658';

function oldPlanEnv(label, sha256) {
  return {
    EVENT: 'workflow_call',
    OVERRIDES: '[]',
    CANDIDATE_PACKAGE: CDP,
    CANDIDATE_ARTIFACT: `cert-pr-pack-340-${'0c157b25'.repeat(5)}-1-${label}`,
    CANDIDATE_RUN: OLD_RUN,
    CANDIDATE_SHA256: sha256,
    CANDIDATE_REPO: 'ai-ecoverse/slicc-cdp',
    REPEAT: '3',
    LABEL: label,
    EXPECT: '',
    SHARDS: '["packages-update-cdp","guard"]',
    BIOS_REF: OLD_PIN,
    TOOLS_SHA: '85a0dc54cb0cb3d75cd56c842d04888895de57bd',
    GITHUB_REPOSITORY: 'ai-ecoverse/slicc-cdp',
    GITHUB_RUN_ID: OLD_RUN,
  };
}

async function toolsCopy() {
  const { cp, mkdtemp, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'canary-old-call-')));
  await cp(new URL('../../scripts/canary/', import.meta.url), join(dir, 'scripts/canary'), {
    recursive: true,
  });
  return {
    dir,
    plan: pathToFileURL(join(dir, 'scripts/canary/plan.mjs')),
    report: pathToFileURL(join(dir, 'scripts/canary/report.mjs')),
  };
}

function cdpShard(name, env) {
  const version = '1.27.0-pr.340.1';
  return {
    ...shard(0, [pass(`${name} passes`)], name),
    pins: {
      overrides: [{ name: CDP, version, sha256: env.CANDIDATE_SHA256 }],
      candidates: {
        [`${CDP}@${version}`]: {
          via: 'artifact',
          files: ['package.json'],
          source: { run: env.CANDIDATE_RUN, artifact: env.CANDIDATE_ARTIFACT },
          sha256: env.CANDIDATE_SHA256,
        },
      },
      held: [],
    },
  };
}

test('main’s scripts take a call from canary.yml@4025d6a: its plan binds the candidate by name, and its --prefix report reads the shards it downloaded', async () => {
  const { mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const tools = await toolsCopy();
  try {
    for (const label of ['base', 'candidate']) {
      const env = oldPlanEnv(label, (label === 'base' ? 'e' : 'f').repeat(64));
      const planned = await cli(tools.plan, [], { ...env, CWD: tools.dir });
      assert.equal(planned.code, 0, planned.stdout);
      assert.doesNotMatch(planned.stdout, /strict candidate|refusing/);
      assert.match(
        planned.stdout,
        /^canary plan: legacy binding, the calling canary.yml passes no candidate-binding$/m
      );
      assert.match(planned.stdout, /^canary plan: PASS 1 runs$/m);
      assert.equal(planned.outputs.prefix, `${label}-`);
      assert.equal(planned.outputs.refused, undefined);
      const runs = JSON.parse(planned.outputs.runs);
      assert.equal(runs[0].ref, OLD_PIN);
      assert.equal(runs[0].repeat, 3);
      assert.deepEqual(runs[0].candidate, {
        package: CDP,
        artifact: env.CANDIDATE_ARTIFACT,
        run: OLD_RUN,
        sha256: env.CANDIDATE_SHA256,
        repo: 'ai-ecoverse/slicc-cdp',
        binding: 'legacy',
      });
      assert.deepEqual(
        JSON.parse(planned.outputs.jobs).map(({ shard: name }) => name),
        ['packages-update-cdp', 'guard']
      );

      const work = join(tools.dir, label);
      for (const name of runs[0].shards) {
        const at = join(work, 'shards', `${label}-canary-shard-canary-${name}`);
        await mkdir(at, { recursive: true });
        await writeFile(join(at, 'shard.json'), JSON.stringify(cdpShard(name, env)));
      }
      const url = `https://github.com/ai-ecoverse/slicc-cdp/actions/runs/${OLD_RUN}`;
      const call = {
        RUNS: planned.outputs.runs,
        CANARY_RUNNER: 'ubuntu-latest',
        RUN_URL: url,
        PREFIX: planned.outputs.prefix,
        CWD: work,
      };
      const args = ['--dir', 'shards', '--runs', call.RUNS, '--out', 'canary', '--prefix'];
      const reported = await cli(tools.report, [...args, call.PREFIX], call);
      assert.equal(reported.code, 0, reported.stdout);
      assert.doesNotMatch(reported.stdout, /ERR_PARSE_ARGS|Unknown option/);
      assert.match(
        reported.stdout,
        /^canary report: legacy shards, read by name under the prefix /m
      );
      assert.equal(reported.outputs.ok, 'true');
      const result = JSON.parse(await readFile(join(work, 'canary/result.json'), 'utf8'));
      assert.equal(result.ok, true);
      assert.equal(result.verdict, 'canary canary: PASS 2 tests');
      assert.equal(result.biosRef, OLD_PIN);
      assert.equal(result.run, 'canary');
      assert.equal(result.repeat, 3);
      assert.equal(result.url, url);
      assert.deepEqual(result.refused, []);
      assert.deepEqual(result.candidates, [
        {
          package: `${CDP}@1.27.0-pr.340.1`,
          status: `candidate (artifact ${OLD_RUN}/${env.CANDIDATE_ARTIFACT}, sha256 ${env.CANDIDATE_SHA256})`,
          via: 'artifact',
        },
      ]);

      const stray = join(work, 'shards', `${label}-canary-shard-canary-guard-extra`);
      await mkdir(stray, { recursive: true });
      await writeFile(join(stray, 'shard.json'), JSON.stringify(cdpShard('guard', env)));
      const forged = await cli(tools.report, [...args, call.PREFIX], call);
      assert.equal(forged.code, 1);
      assert.match(
        JSON.parse(await readFile(join(work, 'canary/result.json'), 'utf8')).verdict,
        new RegExp(`FAIL refused ${label}-canary-shard-canary-guard-extra`)
      );
      const mixed = await cli(
        tools.report,
        [...args, call.PREFIX, '--bindings', 'bindings.json'],
        call
      );
      assert.equal(mixed.code, 1);
      assert.equal(mixed.outputs.ok, undefined);
    }
  } finally {
    await rm(tools.dir, { recursive: true, force: true });
  }
});

test('a caller of the current canary.yml that passes no artifact id and digest is still refused as strict', async () => {
  const { rm } = await import('node:fs/promises');
  const { bindingOf } = await import('../../scripts/canary/plan.mjs');
  assert.equal(bindingOf({}), 'legacy');
  assert.equal(bindingOf({ CANDIDATE_BINDING: '' }), '');
  assert.equal(bindingOf({ CANDIDATE_ARTIFACT_ID: '' }), '');
  assert.equal(bindingOf({ CANDIDATE_ARTIFACT_DIGEST: '' }), '');
  assert.equal(bindingOf({ CANDIDATE_BINDING: 'legacy' }), 'legacy');
  const tools = await toolsCopy();
  try {
    const old = oldPlanEnv('candidate', 'f'.repeat(64));
    const current = {
      ...old,
      CANDIDATE_ARTIFACT_ID: '',
      CANDIDATE_ARTIFACT_DIGEST: '',
      CANDIDATE_BINDING: '',
      CWD: tools.dir,
    };
    const refused = await cli(tools.plan, [], current);
    assert.equal(refused.code, 1);
    assert.match(
      refused.stdout,
      /^canary plan: FAIL a strict candidate needs candidate-artifact-id and candidate-artifact-digest .*refusing it$/m
    );
    assert.equal(refused.outputs.jobs, undefined);
    const { CANDIDATE_BINDING: _unset, ...partial } = current;
    const half = await cli(tools.plan, [], partial);
    assert.equal(half.code, 1);
    assert.match(half.stdout, /^canary plan: FAIL a strict candidate needs /m);
    const digestOnly = await cli(tools.plan, [], {
      ...old,
      CANDIDATE_ARTIFACT_DIGEST: ONE,
      CWD: tools.dir,
    });
    assert.equal(digestOnly.code, 1);
    assert.match(digestOnly.stdout, /^canary plan: FAIL .*go together; refusing it$/m);
  } finally {
    await rm(tools.dir, { recursive: true, force: true });
  }
});

const VECTORS = `import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const counter = process.env.CANARY_FIXTURE_RUNS;
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(n));
for (const detach of ['early', 'late']) {
  test(\`C1–C4 and E1 at registration, \${detach} detach\`, async (t) => {
    await t.test('C1.href.seven control', () => {
      if (process.env.CANARY_FIXTURE_FAIL === detach) throw new Error('control broke');
    });
    await t.test('C1.href.seven protected', () => {});
  });
}
test('steady', () => {});
if (n < 3) test('partial', () => {});
test('skipped once', { skip: n === 2 }, () => {});
`;

const TWINS = `import { test } from 'node:test';
test('outer', async (t) => {
  await t.test('same', () => {});
  await t.test('same', () => {});
});
`;

async function shardRoot() {
  const { cp, mkdir, mkdtemp, realpath, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'canary-shard-')));
  await cp(new URL('../../scripts/canary/', import.meta.url), join(dir, 'scripts/canary'), {
    recursive: true,
  });
  await writeFile(
    join(dir, 'scripts/canary/shards.json'),
    JSON.stringify({
      guard: { match: '/guard-vectors\\.test\\.mjs$' },
      twins: { match: '/twins\\.test\\.mjs$' },
    })
  );
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: {
        test: 'node --test --test-concurrency=1 ${SLICC_TESTS:-test/integration/*.test.mjs}',
      },
    })
  );
  await mkdir(join(dir, 'src/packages'), { recursive: true });
  await writeFile(join(dir, 'src/packages/package.json'), '{}\n');
  await mkdir(join(dir, 'test/integration'), { recursive: true });
  await writeFile(join(dir, 'test/integration/guard-vectors.test.mjs'), VECTORS);
  await writeFile(join(dir, 'test/integration/twins.test.mjs'), TWINS);
  return {
    dir,
    shard: pathToFileURL(join(dir, 'scripts/canary/shard.mjs')),
    report: pathToFileURL(join(dir, 'scripts/canary/report.mjs')),
  };
}

async function reportShards(script, dir, docs, repeat = 1) {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const verified = [];
  for (const doc of docs) {
    const name = `shard-${doc.shard}`;
    await mkdir(join(dir, 'shards', name), { recursive: true });
    await writeFile(join(dir, 'shards', name, 'shard.json'), JSON.stringify(doc));
    verified.push({ run: 'canary', shard: doc.shard, name });
  }
  await writeFile(
    join(dir, 'bindings.json'),
    JSON.stringify({ verdict: 'canary bindings: PASS', verified, refused: [] })
  );
  const runs = [
    {
      id: 'canary',
      ref: 'f'.repeat(40),
      overrides: [],
      shards: docs.map(({ shard: name }) => name),
      expect: [],
      repeat,
    },
  ];
  const out = join(dir, 'canary');
  const done = await cli(script, [
    '--dir',
    join(dir, 'shards'),
    '--runs',
    JSON.stringify(runs),
    '--out',
    out,
    '--bindings',
    join(dir, 'bindings.json'),
    '--download',
    'success',
  ]);
  const read = async (file) => JSON.parse(await readFile(join(out, file), 'utf8'));
  return {
    ...done,
    result: await read('result.json'),
    canary: await read('canary.json'),
    verdicts: (await readFile(join(out, 'verdict.txt'), 'utf8')).trim().split('\n'),
  };
}

test('a repeated shard reports every row in tests under its full node:test ancestry, so the guard vectors’ names under each detach are distinct keys, and a skipped or missing repeat counts no run', async () => {
  const { readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await shardRoot();
  try {
    const out = join(root.dir, 'out/guard');
    const ran = await cli(root.shard, ['--shard', 'guard', '--repeat', '3', '--out', out], {
      CANARY_FIXTURE_RUNS: join(root.dir, 'runs.txt'),
      CWD: root.dir,
    });
    assert.equal(ran.code, 0, ran.stdout);
    const doc = JSON.parse(await readFile(join(out, 'shard.json'), 'utf8'));
    const file = 'test/integration/guard-vectors.test.mjs';
    const parent = (detach) => `C1–C4 and E1 at registration, ${detach} detach`;
    const row = (key, test, candidate) => ({
      shard: 'guard',
      key: [file, ...key].join(' › '),
      test,
      verdict: 'pass',
      failed: { candidate, baseline: '0/0' },
    });
    const expected = ['early', 'late'].flatMap((detach) => [
      row(
        [parent(detach), 'C1.href.seven control'],
        'guard-vectors.test.mjs › C1.href.seven control',
        '0/3'
      ),
      row(
        [parent(detach), 'C1.href.seven protected'],
        'guard-vectors.test.mjs › C1.href.seven protected',
        '0/3'
      ),
      row([parent(detach)], `guard-vectors.test.mjs › ${parent(detach)}`, '0/3'),
    ]);
    expected.push(
      row(['steady'], 'guard-vectors.test.mjs › steady', '0/3'),
      row(['partial'], 'guard-vectors.test.mjs › partial', '0/2'),
      row(['skipped once'], 'guard-vectors.test.mjs › skipped once', '0/2')
    );
    const reported = await reportShards(root.report, root.dir, [doc], 3);
    assert.equal(reported.code, 0, reported.stdout);
    assert.equal(reported.result.verdict, 'canary canary: PASS 9 tests');
    assert.deepEqual(reported.result.tests, expected);
    assert.equal(reported.result.tests[0].test, reported.result.tests[3].test);
    assert.notEqual(reported.result.tests[0].key, reported.result.tests[3].key);
    assert.deepEqual(reported.result.ambiguous, []);
    assert.deepEqual(reported.canary.tests, expected);
    assert.deepEqual(
      reported.canary.results.map(({ key }) => key),
      expected.map(({ key }) => key)
    );
  } finally {
    await rm(root.dir, { recursive: true, force: true });
  }
});

test('two rows in one shard with the same key turn the report red and name the key', async () => {
  const { readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await shardRoot();
  try {
    const out = join(root.dir, 'out/twins');
    const ran = await cli(root.shard, ['--shard', 'twins', '--out', out], { CWD: root.dir });
    assert.equal(ran.code, 0, ran.stdout);
    const doc = JSON.parse(await readFile(join(out, 'shard.json'), 'utf8'));
    const key = 'test/integration/twins.test.mjs › outer › same';
    const reported = await reportShards(root.report, root.dir, [doc]);
    assert.equal(reported.code, 1);
    assert.equal(reported.outputs.ok, 'false');
    assert.equal(reported.result.ok, false);
    assert.equal(
      reported.result.verdict,
      `canary canary: FAIL ambiguous test keys: 2 rows in shard twins share the key ${key}`
    );
    assert.deepEqual(reported.result.ambiguous, [{ shard: 'twins', key, rows: 2 }]);
    assert.match(
      markdown(reported.canary),
      /\*\*twins\*\*: 2 rows share the key test\/integration\/twins\.test\.mjs › outer › same/
    );
    const keyless = await reportShards(root.report, root.dir, [
      { ...doc, results: doc.results.map(({ key: _key, ...rest }) => rest) },
    ]);
    assert.equal(keyless.code, 1);
    assert.equal(
      keyless.result.verdict,
      'canary canary: FAIL ambiguous test keys: 3 rows in shard twins have no key'
    );
  } finally {
    await rm(root.dir, { recursive: true, force: true });
  }
});

test('tests lists every row past the 100 the summaries keep, with its completed runs, and the summary’s other fields stay as they were', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'canary-tests-'));
  try {
    const broken = (n) => ({ ...pass(`broken ${n}`), status: 'fail', log: `broken ${n} failed` });
    const rows = [
      ...Array.from({ length: 120 }, (_, n) => broken(n)),
      ...Array.from({ length: 30 }, (_, n) => pass(`fine ${n}`)),
    ];
    const reported = await reportShards(REPORT, dir, [shard(1, rows)]);
    assert.equal(reported.code, 1);
    const { result } = reported;
    assert.deepEqual(Object.keys(result), [
      'ok',
      'run',
      'biosRef',
      'url',
      'repeat',
      'overrides',
      'candidates',
      'counts',
      'regressions',
      'both',
      'flaky',
      'failures',
      'missingShards',
      'unexplainedExits',
      'refused',
      'ambiguous',
      'tests',
      'verdict',
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.verdict, 'canary canary: FAIL 120 regression');
    assert.equal(result.repeat, 1);
    assert.deepEqual(result.counts, {
      pass: 30,
      skip: 0,
      fail: 0,
      regression: 120,
      both: 0,
      flaky: 0,
    });
    assert.equal(result.regressions.length, 100);
    assert.deepEqual(result.regressions[0], {
      shard: 'rest',
      test: 'broken 0',
      log: 'broken 0 failed',
    });
    assert.deepEqual([result.missingShards, result.unexplainedExits, result.refused], [[], [], []]);
    assert.equal(result.tests.length, 150);
    assert.deepEqual(result.tests[119], {
      shard: 'rest',
      key: keyOf('broken 119'),
      test: 'broken 119',
      verdict: 'regression',
      failed: { candidate: '1/1', baseline: '0/0' },
    });
    assert.deepEqual(result.tests[149], {
      shard: 'rest',
      key: keyOf('fine 29'),
      test: 'fine 29',
      verdict: 'pass',
      failed: { candidate: '0/1', baseline: '0/0' },
    });
    assert.deepEqual(reported.canary.tests, result.tests);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed in tests counts only the runs that completed, the baseline rerun and the retry included', () => {
  const row = (name, fields) => ({ ...pass(name), ...fields });
  const merged = report(
    [
      shard(1, [
        row('skips a run', { runs: ['pass', 'skip', 'pass'], baselines: [] }),
        row('misses a run', {
          status: 'fail',
          runs: ['fail', 'pass'],
          baselines: ['pass', 'pass'],
        }),
        row('never ran', { status: 'skip', runs: ['skip', 'skip', 'skip'], baselines: [] }),
      ]),
      shard(
        1,
        [
          row('regression', { status: 'fail', baseline: 'pass', retry: 'fail' }),
          row('flaky', { status: 'fail', baseline: 'pass', retry: 'pass' }),
          row('both', { status: 'fail', baseline: 'fail' }),
        ],
        'once'
      ),
    ],
    { repeat: 3, strict: false },
    ['rest', 'once']
  );
  assert.deepEqual(
    merged.tests.map(({ test, verdict, failed }) => [
      test,
      verdict,
      failed.candidate,
      failed.baseline,
    ]),
    [
      ['skips a run', 'pass', '0/2', '0/0'],
      ['misses a run', 'flaky', '1/2', '0/2'],
      ['never ran', 'skip', '0/0', '0/0'],
      ['regression', 'regression', '2/2', '0/1'],
      ['flaky', 'flaky', '1/2', '0/1'],
      ['both', 'both', '1/1', '1/1'],
    ]
  );
});

test('a result over 512 KB is a FAIL verdict, not a truncated list, and canary.json keeps every row', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'canary-bound-'));
  try {
    const rows = Array.from({ length: 2000 }, (_, n) => pass(`${'a long name '.repeat(20)}${n}`));
    const reported = await reportShards(REPORT, dir, [shard(0, rows)]);
    assert.equal(reported.code, 1);
    assert.equal(reported.outputs.ok, 'false');
    const { result } = reported;
    assert.equal(result.ok, false);
    assert.match(
      result.verdict,
      /^canary: FAIL the result is \d+ bytes, over the 520192 that leave room for its artifact under the 524288-byte bound for a job output; canary\.json holds every row$/
    );
    assert.ok(result.bytes > 520192);
    assert.equal(result.tests, undefined);
    assert.deepEqual(reported.verdicts, ['canary canary: PASS 2000 tests', result.verdict]);
    assert.equal(reported.canary.tests.length, 2000);
    const fits = await reportShards(REPORT, dir, [shard(0, rows.slice(0, 400))]);
    assert.equal(fits.code, 0, fits.stdout);
    assert.equal(fits.result.tests.length, 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing leaf changes only its own row: its parents keep their rows, so the keys are those of the all-pass run', async () => {
  const { readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await shardRoot();
  try {
    const side = async (name, extra) => {
      const out = join(root.dir, name, 'out');
      const ran = await cli(root.shard, ['--shard', 'guard', '--out', out], {
        CANARY_FIXTURE_RUNS: join(root.dir, `${name}.txt`),
        CWD: root.dir,
        ...extra,
      });
      const doc = JSON.parse(await readFile(join(out, 'shard.json'), 'utf8'));
      return { ran, ...(await reportShards(root.report, join(root.dir, name), [doc])) };
    };
    const green = await side('green', {});
    const red = await side('red', { CANARY_FIXTURE_FAIL: 'late' });
    assert.equal(green.code, 0, green.stdout);
    assert.equal(red.ran.code, 0, red.ran.stdout);
    assert.equal(red.code, 1);
    const keys = (side) => side.result.tests.map(({ key }) => key);
    assert.equal(keys(green).length, 9);
    assert.deepEqual(keys(red), keys(green));
    assert.deepEqual(
      red.canary.results.map(({ key }) => key),
      green.canary.results.map(({ key }) => key)
    );
    const leaf =
      'test/integration/guard-vectors.test.mjs › C1–C4 and E1 at registration, late detach › C1.href.seven control';
    const changed = red.result.tests.filter(
      (row, n) => JSON.stringify(row) !== JSON.stringify(green.result.tests[n])
    );
    assert.deepEqual(changed, [
      {
        shard: 'guard',
        key: leaf,
        test: 'guard-vectors.test.mjs › C1.href.seven control',
        verdict: 'fail',
        failed: { candidate: '1/1', baseline: '0/0' },
      },
    ]);
    assert.equal(
      red.result.tests.find(({ key }) => key === leaf.slice(0, leaf.lastIndexOf(' › '))).verdict,
      'pass'
    );
    assert.deepEqual(green.result.counts, {
      pass: 9,
      skip: 0,
      fail: 0,
      regression: 0,
      both: 0,
      flaky: 0,
    });
    assert.deepEqual(red.result.counts, {
      pass: 8,
      skip: 0,
      fail: 1,
      regression: 0,
      both: 0,
      flaky: 0,
    });
    assert.deepEqual(
      red.result.failures.map(({ test, log }) => [test, log.split('\n')[0]]),
      [['guard-vectors.test.mjs › C1.href.seven control', 'control broke']]
    );
    assert.equal(red.result.verdict, 'canary canary: FAIL 1 fail');
  } finally {
    await rm(root.dir, { recursive: true, force: true });
  }
});

test('the result step never writes a job output over 512 KB once it adds the artifact block', async () => {
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const yml = await readFile(
    new URL('../../.github/workflows/canary.yml', import.meta.url),
    'utf8'
  );
  const step = stepsOf(yml.slice(yml.indexOf('\n  report:'))).find((one) =>
    /^ {6}- id: result\n/.test(one)
  );
  const script = step.match(/node -e '\n([\s\S]*?)\n\s*'\n?$/)[1];
  const dir = await mkdtemp(join(tmpdir(), 'canary-step-'));
  try {
    await mkdir(join(dir, 'canary'));
    const file = join(dir, 'step.cjs');
    await writeFile(file, script);
    const env = {
      CWD: dir,
      ARTIFACT_NAME: 'candidate-canary',
      ARTIFACT_URL: 'https://example.test/a',
      ARTIFACT_ID: '9001',
      ARTIFACT_DIGEST: 'ab'.repeat(32),
    };
    const verdict = 'canary canary: PASS 1 tests';
    const write = (result) => writeFile(join(dir, 'canary/result.json'), JSON.stringify(result));
    await write({ ok: true, verdict, tests: [] });
    const fits = await cli(pathToFileURL(file), [], env);
    assert.equal(fits.code, 0, fits.stdout);
    assert.equal(fits.stdout.trim(), verdict);
    assert.deepEqual(JSON.parse(fits.outputs.result).artifact, {
      name: 'candidate-canary',
      url: 'https://example.test/a',
      id: '9001',
      digest: 'ab'.repeat(32),
    });
    const full = `result=${JSON.stringify({ ok: true, verdict, tests: [], artifact: JSON.parse(fits.outputs.result).artifact })}\n`;
    await write({ ok: true, verdict, tests: [], pad: 'x'.repeat(524288 - full.length) });
    const over = await cli(pathToFileURL(file), [], env);
    assert.equal(over.code, 1);
    assert.match(
      over.stdout,
      /^canary: FAIL the result is 524\d{3} bytes with its artifact, over the 524288-byte bound for a job output$/m
    );
    assert.equal(over.outputs.result, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
