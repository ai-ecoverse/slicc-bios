import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { changedPins, failedFiles, scenario, scenarioOf } from '../../scripts/cert/evidence.mjs';
import { exceptionsFor, judge, releaseState, writerOf } from '../../scripts/cert/release-state.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'release-state-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const INTEGRITY = `sha512-${Buffer.from('a'.repeat(64)).toString('base64')}`;
const HEX = Buffer.from(INTEGRITY.slice(7), 'base64').toString('hex');
const COMMIT = 'c'.repeat(40);
const PARENT = 'p'.repeat(40).replace(/p/g, 'd');

function statement({
  repository,
  path = '.github/workflows/release.yml',
  ref = 'refs/heads/main',
  digest = HEX,
  commit = COMMIT,
}) {
  const payload = {
    subject: [{ digest: { sha512: digest } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { repository, path, ref } },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
      runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
    },
  };
  return {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString('base64') },
        },
      },
    ],
  };
}

function fake(o = {}) {
  return {
    version: async () => ({ dist: { integrity: o.integrity ?? INTEGRITY } }),
    tags: async () => o.tags ?? {},
    attestations: async () => o.attestations ?? null,
    compare: async () => ({ status: o.compare ?? 'behind' }),
    commit: async () =>
      o.commit ?? { parents: [{ sha: PARENT }], files: [{ filename: 'src/x.rs' }] },
    statuses: async (repo, sha) => o.statuses?.[sha] ?? [],
    checks: async (repo, sha) => ({ check_runs: o.checks?.[sha] ?? [] }),
    run: async (repo, id) => o.runs?.[id] ?? null,
    exceptions: async () => o.exceptions ?? null,
  };
}

const status = (o = {}) => ({
  context: 'cert-review',
  state: 'success',
  creator: { login: 'github-actions[bot]' },
  description: '#1 certified at abc',
  ...o,
});
const KERNEL = '@ai-ecoverse/slicc-kernel@1.200.0';
const kernelProv = statement({ repository: 'https://github.com/ai-ecoverse/slicc-kernel' });

test('writers: kernel, jsh, mcpcat and wasi-slicc (slicc-cli) by their main commit, cdp, clipboard and tailscale by the certified tag, homescoop by its ladder', () => {
  assert.deepEqual(
    [
      'slicc-kernel',
      'slicc-jsh',
      'mcpcat',
      'slicc-cdp',
      'slicc-clipboard',
      'wasm-tailscale',
      'wasi-slicc',
      'wasm-bash',
      'py-numpy',
      'wasix-perl',
      'wasi-pnpm',
      'slicc-agent',
    ].map((n) => writerOf(`@ai-ecoverse/${n}`).kind),
    [
      'main',
      'main',
      'main',
      'tag',
      'tag',
      'tag',
      'main',
      'homescoop',
      'homescoop',
      'homescoop',
      'homescoop',
      'none',
    ]
  );
});

test('a main-writer pin passes on its release commit’s cert-review status from github-actions[bot], and on nothing weaker', async () => {
  const ok = await judge(
    fake({ attestations: kernelProv, statuses: { [COMMIT]: [status()] } }),
    KERNEL,
    INTEGRITY
  );
  assert.equal(ok.ok, true, ok.line);
  assert.match(
    ok.line,
    /certified at slicc-kernel cccccccccccc: cert-review status: #1 certified at abc/
  );
  for (const [why, o, re] of [
    [
      'another creator',
      { statuses: { [COMMIT]: [status({ creator: { login: 'someone' } })] } },
      /carries no cert-review success/,
    ],
    [
      'a failure',
      { statuses: { [COMMIT]: [status({ state: 'failure' })] } },
      /carries no cert-review success/,
    ],
    [
      'the newest status is a failure',
      { statuses: { [COMMIT]: [status({ state: 'failure' }), status()] } },
      /carries no cert-review success/,
    ],
    [
      'another context',
      { statuses: { [COMMIT]: [status({ context: 'cert-review-pr' })] } },
      /carries no cert-review success/,
    ],
    [
      'a commit off main',
      { compare: 'diverged', statuses: { [COMMIT]: [status()] } },
      /is not on main \(diverged\)/,
    ],
    [
      'provenance from a branch',
      {
        attestations: statement({
          repository: 'https://github.com/ai-ecoverse/slicc-kernel',
          ref: 'refs/heads/x',
        }),
      },
      /not slicc-kernel's release\.yml at main/,
    ],
    [
      'provenance from another repository',
      { attestations: statement({ repository: 'https://github.com/evil/slicc-kernel' }) },
      /not slicc-kernel's release\.yml at main/,
    ],
    [
      'provenance for another tarball',
      {
        attestations: statement({
          repository: 'https://github.com/ai-ecoverse/slicc-kernel',
          digest: 'f'.repeat(128),
        }),
      },
      /names another tarball/,
    ],
    ['no provenance', { attestations: null }, /no npm provenance/],
    [
      'another integrity on the registry',
      { integrity: 'sha512-other', attestations: kernelProv },
      /the registry's integrity sha512-other is not the lockfile's/,
    ],
  ]) {
    const r = await judge(fake({ attestations: kernelProv, ...o }), KERNEL, INTEGRITY);
    assert.equal(r.ok, false, why);
    assert.match(r.line, re, why);
  }
});

test('a version-only release commit by the release bot is judged by its parent; a code commit, another author or a package.json that changes more than its version never is', async () => {
  const bump = {
    filename: 'package.json',
    patch: '@@ -1,3 +1,3 @@\n-  "version": "1.199.0",\n+  "version": "1.200.0",\n',
  };
  const versionOnly = {
    author: { login: 'github-actions[bot]' },
    parents: [{ sha: PARENT }],
    files: [bump, { filename: 'CHANGELOG.md', patch: '+x' }],
  };
  const r = await judge(
    fake({ attestations: kernelProv, commit: versionOnly, statuses: { [PARENT]: [status()] } }),
    KERNEL,
    INTEGRITY
  );
  assert.equal(r.ok, true, r.line);
  assert.match(r.line, /certified at slicc-kernel dddddddddddd/);
  const code = await judge(
    fake({ attestations: kernelProv, statuses: { [PARENT]: [status()] } }),
    KERNEL,
    INTEGRITY
  );
  assert.equal(code.ok, false);
  for (const [why, c] of [
    ['another author', { ...versionOnly, author: { login: 'someone' } }],
    [
      'a dependency change in package.json',
      { ...versionOnly, files: [{ filename: 'package.json', patch: '+    "evil": "1.0.0",\n' }] },
    ],
    ['a merge commit', { ...versionOnly, parents: [{ sha: PARENT }, { sha: COMMIT }] }],
  ]) {
    const got = await judge(
      fake({ attestations: kernelProv, commit: c, statuses: { [PARENT]: [status()] } }),
      KERNEL,
      INTEGRITY
    );
    assert.equal(got.ok, false, why);
  }
});

test('v2: a cert-review check run counts only from app 15368, with an external_id naming a merge_group run of cert-review.yml on that commit', async () => {
  const check = (o = {}) => ({
    id: 9,
    app: { id: 15368 },
    conclusion: 'success',
    external_id: `v2:group:${COMMIT}:77:1`,
    output: { title: 'group: #1 certified' },
    ...o,
  });
  const run = (o = {}) => ({
    path: '.github/workflows/cert-review.yml',
    event: 'merge_group',
    head_sha: COMMIT,
    ...o,
  });
  const pass = await judge(
    fake({ attestations: kernelProv, checks: { [COMMIT]: [check()] }, runs: { 77: run() } }),
    KERNEL,
    INTEGRITY
  );
  assert.equal(pass.ok, true, pass.line);
  assert.match(pass.line, /cert-review check 9: group: #1 certified/);
  for (const [why, c, r] of [
    ['another app', check({ app: { id: 1 } }), run()],
    ['a failure', check({ conclusion: 'failure' }), run()],
    ['a pull_request_target run', check(), run({ event: 'pull_request_target' })],
    ['another workflow', check(), run({ path: '.github/workflows/spoof.yml' })],
    ['another head', check(), run({ head_sha: 'e'.repeat(40) })],
    ['no external_id', check({ external_id: null }), run()],
    [
      'an external_id for another commit',
      check({ external_id: `v2:group:${'e'.repeat(40)}:77:1` }),
      run(),
    ],
  ]) {
    const got = await judge(
      fake({ attestations: kernelProv, checks: { [COMMIT]: [c] }, runs: { 77: r } }),
      KERNEL,
      INTEGRITY
    );
    assert.equal(got.ok, false, why);
  }
});

test('kernel also passes on its certified tag; cdp, clipboard, tailscale and wasi-slicc only on it', async () => {
  assert.equal((await judge(fake({ tags: { certified: '1.200.0' } }), KERNEL, INTEGRITY)).ok, true);
  assert.equal(
    (
      await judge(
        fake({ tags: { certified: '1.30.11' } }),
        '@ai-ecoverse/slicc-cdp@1.30.11',
        INTEGRITY
      )
    ).ok,
    true
  );
  const cdp = await judge(
    fake({ tags: { certified: '1.30.11', latest: '1.30.12' } }),
    '@ai-ecoverse/slicc-cdp@1.30.12',
    INTEGRITY
  );
  assert.equal(cdp.ok, false);
  assert.match(cdp.line, /npm dist-tag certified is 1\.30\.11, not 1\.30\.12/);
  const bound = await judge(
    fake({ tags: { certified: '1.0.2' }, integrity: 'sha512-other' }),
    '@ai-ecoverse/slicc-clipboard@1.0.2',
    INTEGRITY
  );
  assert.equal(bound.ok, false, 'the tag is byte-bound by the integrity');
});

const ladder = statement({
  repository: 'https://github.com/ai-ecoverse/homescoop',
  path: '.github/workflows/ladder-build.yml',
});
const file = (entries) => ({ schema: 1, entries });

test('homescoop: ladder-build provenance at main certifies any version, minus the deny and requires rulings of its exceptions file', async () => {
  const bash = '@ai-ecoverse/wasm-bash@5.3.0-19';
  const ok = await judge(fake({ attestations: ladder }), bash, INTEGRITY, file([]));
  assert.equal(ok.ok, true, ok.line);
  const deny = file([
    {
      package: '@ai-ecoverse/py-cycler',
      versions: ['0.12.1-9'],
      verdict: 'fail',
      issue: 'https://x/858',
      ruling: 'lane',
    },
  ]);
  const cycler = await judge(
    fake({ attestations: ladder }),
    '@ai-ecoverse/py-cycler@0.12.1-9',
    INTEGRITY,
    deny
  );
  assert.equal(cycler.ok, false);
  assert.match(cycler.line, /uncertified by ruling \(https:\/\/x\/858, lane\)/);
  const range = file([
    {
      package: '@ai-ecoverse/py-pandas',
      range: '>=2.3.2-5 <=2.3.2-11',
      verdict: 'fail',
      issue: 'https://x/730',
    },
  ]);
  assert.equal(
    (
      await judge(
        fake({ attestations: ladder }),
        '@ai-ecoverse/py-pandas@2.3.2-7',
        INTEGRITY,
        range
      )
    ).ok,
    false
  );
  assert.equal(
    (
      await judge(
        fake({ attestations: ladder }),
        '@ai-ecoverse/py-pandas@2.3.2-12',
        INTEGRITY,
        range
      )
    ).ok,
    true
  );
  const requires = file([
    {
      package: '@ai-ecoverse/wasm-bash',
      versions: ['5.3.0-20'],
      verdict: 'requires',
      requires: { '@ai-ecoverse/slicc-kernel': '>=1.130.2' },
      issue: 'https://x/1230',
    },
  ]);
  const old = new Map([['@ai-ecoverse/slicc-kernel@1.129.0', 'x']]);
  const neu = new Map([['@ai-ecoverse/slicc-kernel@1.130.2', 'x']]);
  const held = await judge(
    fake({ attestations: ladder }),
    '@ai-ecoverse/wasm-bash@5.3.0-20',
    INTEGRITY,
    requires,
    old
  );
  assert.equal(held.ok, false);
  assert.match(held.line, /needs @ai-ecoverse\/slicc-kernel >=1\.130\.2, and bios pins 1\.129\.0/);
  assert.equal(
    (
      await judge(
        fake({ attestations: ladder }),
        '@ai-ecoverse/wasm-bash@5.3.0-20',
        INTEGRITY,
        requires,
        neu
      )
    ).ok,
    true
  );
  for (const [why, o] of [
    ['no provenance', {}],
    [
      'another workflow',
      {
        attestations: statement({
          repository: 'https://github.com/ai-ecoverse/homescoop',
          path: '.github/workflows/x.yml',
        }),
      },
    ],
    [
      'a branch',
      {
        attestations: statement({
          repository: 'https://github.com/ai-ecoverse/homescoop',
          path: '.github/workflows/ladder-build.yml',
          ref: 'refs/heads/pr',
        }),
      },
    ],
  ]) {
    const r = await judge(fake(o), bash, INTEGRITY, file([]));
    assert.equal(r.ok, false, why);
  }
});

test('the exceptions file fails closed: unreadable, another schema, unknown keys or verdicts, both or neither of versions and range', () => {
  for (const [why, f] of [
    ['unreadable', null],
    ['another schema', { schema: 2, entries: [] }],
    ['an unknown top-level key', { schema: 1, entries: [], stays: [] }],
    [
      'an unknown entry key',
      file([{ package: 'p', versions: ['1'], verdict: 'fail', stays: true }]),
    ],
    ['an unknown verdict', file([{ package: 'p', versions: ['1'], verdict: 'accept' }])],
    [
      'both versions and range',
      file([{ package: 'p', versions: ['1'], range: '>=1', verdict: 'fail' }]),
    ],
    ['neither', file([{ package: 'p', verdict: 'fail' }])],
    ['a bad range', file([{ package: 'p', range: 'not a range ((', verdict: 'fail' }])],
    [
      'requires with nothing',
      file([{ package: 'p', versions: ['1'], verdict: 'requires', requires: {} }]),
    ],
  ])
    assert.ok(exceptionsFor(f, 'x', '1', new Map()).error, why);
  assert.deepEqual(exceptionsFor(file([]), 'x', '1', new Map()), {});
});

function repo() {
  const dir = mkdtempSync(join(scratch, 'repo-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  const write = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('init', '-q', '-b', 'main');
  return { dir, git, write };
}
const npmLock = (rows) =>
  JSON.stringify({
    packages: {
      '': {},
      ...Object.fromEntries(
        rows.map(([n, v, i]) => [`node_modules/${n}`, { version: v, integrity: i }])
      ),
    },
  });

test('release-state judges only the gated pins and certs.json lines a change adds, from git, and names each', async () => {
  const { dir, git, write } = repo();
  write(
    'src/packages/package-lock.json',
    npmLock([
      ['@ai-ecoverse/slicc-kernel', '1.199.0', INTEGRITY],
      ['@ai-ecoverse/slicc-spectrum', '1.0.0', 'sha512-s'],
    ])
  );
  write('src/packages/certs.json', '{}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const none = await releaseState({ cwd: dir, base, head: base, src: fake() });
  assert.deepEqual(
    [none.ok, none.line],
    [true, 'release-state: PASS no gated pin or certs.json line changes']
  );
  write(
    'src/packages/package-lock.json',
    npmLock([
      ['@ai-ecoverse/slicc-kernel', '1.200.0', INTEGRITY],
      ['@ai-ecoverse/slicc-spectrum', '1.0.1', 'sha512-t'],
    ])
  );
  write(
    'src/packages/certs.json',
    JSON.stringify({ '@ai-ecoverse/slicc-cdp@1.30.12': { integrity: INTEGRITY } })
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'bump');
  const r = await releaseState({
    cwd: dir,
    base,
    head: 'HEAD',
    src: fake({
      attestations: kernelProv,
      statuses: { [COMMIT]: [status()] },
      tags: { certified: '1.30.11' },
    }),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.rows.map((x) => [x.key, x.ok, x.why]),
    [
      ['@ai-ecoverse/slicc-kernel@1.200.0', true, 'pin'],
      ['@ai-ecoverse/slicc-cdp@1.30.12', false, 'certs.json line'],
    ]
  );
  assert.match(r.line, /^release-state: FAIL @ai-ecoverse\/slicc-cdp@1\.30\.12: not certified/);
  const broken = await releaseState({
    cwd: dir,
    base,
    head: 'HEAD',
    src: {
      ...fake(),
      version: async () => {
        throw new Error('registry down');
      },
    },
  });
  assert.equal(broken.ok, false, 'an error is no pass');
  assert.match(broken.line, /INCOMPLETE registry down/);
});

test('evidence: the pins a PR changes, the files its shards failed (after the retry), and a scenario’s pass lines', () => {
  const base = mkdtempSync(join(scratch, 'base-'));
  const head = mkdtempSync(join(scratch, 'head-'));
  for (const [dir, deps] of [
    [
      base,
      { '@ai-ecoverse/slicc-kernel': '1.1.0', '@ai-ecoverse/slicc-agent': '6.0.0', left: '1' },
    ],
    [
      head,
      { '@ai-ecoverse/slicc-kernel': '1.2.0', '@ai-ecoverse/slicc-agent': '6.0.0', left: '2' },
    ],
  ]) {
    mkdirSync(join(dir, 'src/packages'), { recursive: true });
    writeFileSync(join(dir, 'src/packages/package.json'), JSON.stringify({ dependencies: deps }));
  }
  assert.deepEqual(changedPins(base, head), [
    { name: '@ai-ecoverse/slicc-kernel', version: '1.2.0', from: '1.1.0', gated: true },
  ]);
  const shards = mkdtempSync(join(scratch, 'shards-'));
  mkdirSync(join(shards, 'integration-a/artifacts/experiment'), { recursive: true });
  writeFileSync(
    join(shards, 'integration-a/artifacts/experiment/a.json'),
    JSON.stringify({
      groups: [
        {
          first: { failed: ['test/integration/boot.test.mjs', 'test/integration/k4.test.mjs'] },
          retry: { failed: ['test/integration/k4.test.mjs'] },
        },
        { first: { failed: ['test/integration/x.test.mjs; rm -rf /'] } },
      ],
    })
  );
  assert.deepEqual(
    failedFiles(shards),
    ['test/integration/k4.test.mjs'],
    'a retry that passed clears the file, and a name that is not a test path is dropped'
  );
  assert.equal(scenarioOf('@ai-ecoverse/slicc-kernel'), 'scripts/cert/scenarios/slicc-kernel.txt');
  assert.deepEqual(scenario('# kernel boots\n# pass: prints ok\necho ok\n\nuname -a\n'), {
    pass: ['prints ok'],
    commands: ['echo ok', 'uname -a'],
  });
});

const caller = read('.github/workflows/cert-review.yml');
const ci = read('.github/workflows/ci.yml');

test('the cert-review caller: shared v2 pinned by sha with the same tools-ref, CI evidence from ci.yml, the guard over the cert and CI scripts, and only the Bedrock secret', () => {
  const uses =
    /uses: ai-ecoverse\/slicc-shared-web\/\.github\/workflows\/cert-review\.yml@([0-9a-f]{40})\n/.exec(
      caller
    )?.[1];
  assert.ok(uses);
  assert.match(caller, new RegExp(`\\n {6}tools-ref: ${uses}\\n`));
  assert.match(caller, /\n {6}evidence-workflow: ci\.yml\n/);
  assert.match(
    caller,
    /\n {6}code-check: node scripts\/cert\/release-state\.mjs --base "\$BASE_SHA" --head "\$HEAD_SHA"\n/
  );
  assert.match(caller, /\n {6}evidence-artifacts: \|\n {8}cert-evidence\n {8}integration-\*\n/);
  for (const path of ['.github/workflows/**', 'scripts/cert/**', 'scripts/ci/**'])
    assert.ok(caller.includes(`\n        ${path}\n`), path);
  assert.deepEqual(
    [...caller.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]),
    ['AWS_BEARER_TOKEN_BEDROCK']
  );
  assert.match(caller, /^ {2}pull_request_target:\n/m);
  assert.match(caller, /^ {2}merge_group:\n/m);
  assert.doesNotMatch(caller, /workflow_run|claude-code-action|certs\.json/);
});

test('ci / cert evidence runs pull-request code with a read-only token and no secret, and ci / test runs release-state in code', () => {
  const job = ci.slice(ci.indexOf('\n  evidence:\n'), ci.indexOf('\n  ci:\n'));
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {4}env:/);
  assert.doesNotMatch(job, /secrets\.|: write|persist-credentials: true/);
  assert.equal([...job.matchAll(/persist-credentials: false/g)].length, 2);
  assert.match(
    job,
    /evidence\.mjs reruns --head head --base base --out "\$RUNNER_TEMP\/cert-evidence" --times 3/
  );
  assert.match(job, /name: cert-evidence\n/);
  assert.match(
    ci,
    /node scripts\/cert\/release-state\.mjs --base "\$BASE" --head HEAD --out artifacts\/cert\/release-state\.json\n/
  );
  assert.doesNotMatch(ci, /certified\.mjs|cert \/ queue|git push/);
});

test('no workflow pushes certs.json lines or reads a review comment any more', () => {
  for (const f of ['ci.yml', 'cert-review.yml', 'canary.yml', 'release.yml', 'deploy.yml'])
    assert.doesNotMatch(
      read(`.github/workflows/${f}`),
      /scripts\/cert\/apply\.mjs|scripts\/ci\/certified\.mjs|git push origin/,
      f
    );
});

test('release-state fails a lockfile entry it can’t bind to a registry tarball: a tarball resolution, an aliased or linked gated package', async () => {
  const { dir, git, write } = repo();
  write('src/packages/package-lock.json', npmLock([]));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  let n = 0;
  for (const [why, files] of [
    [
      'a pnpm tarball resolution',
      {
        'src/packages/pnpm-lock.yaml':
          "lockfileVersion: '9.0'\n\npackages:\n\n  '@ai-ecoverse/wasm-bash@5.3.0-30':\n    resolution: {tarball: https://evil.example/x.tgz, integrity: sha512-x}\n",
      },
    ],
    [
      'a pnpm entry with no integrity',
      {
        'src/packages/pnpm-lock.yaml':
          'lockfileVersion: \'9.0\'\n\npackages:\n\n  "@ai-ecoverse/wasm-bash@5.3.0-30":\n    resolution: {directory: ../x}\n',
      },
    ],
    [
      'an npm alias',
      {
        'src/packages/package-lock.json': JSON.stringify({
          packages: {
            '': {},
            'node_modules/bash': {
              name: '@ai-ecoverse/wasm-bash',
              version: '5.3.0-30',
              resolved: 'https://evil.example/x.tgz',
              integrity: 'sha512-x',
            },
          },
        }),
      },
    ],
    [
      'an npm link',
      {
        'src/packages/package-lock.json': JSON.stringify({
          packages: {
            '': {},
            'node_modules/@ai-ecoverse/wasm-bash': { link: true, resolved: '../x' },
          },
        }),
      },
    ],
  ]) {
    git('checkout', '-q', '-B', `t${n++}`, base);
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '-A');
    git('commit', '-q', '-m', why);
    const r = await releaseState({ cwd: dir, base, head: 'HEAD', src: fake() });
    assert.equal(r.ok, false, why);
    assert.match(r.line, /must resolve to a registry tarball with its integrity/, why);
  }
});

test('the homescoop exceptions file is read at a pinned commit, never a branch', async () => {
  const { HOMESCOOP } = await import('../../scripts/cert/release-state.mjs');
  assert.ok(
    /^[0-9a-f]{40}$/.test(HOMESCOOP.exceptions.ref),
    'a sha, or none yet (every homescoop pin change then fails closed)'
  );
});

test('wasi-slicc is slicc-cli’s: its release commit’s cert-review status from 1.44.1, never 1.44.4, and nothing before 1.44.1 (its stale tag is gone)', async () => {
  assert.deepEqual(writerOf('@ai-ecoverse/wasi-slicc'), {
    kind: 'main',
    repo: 'slicc-cli',
    tag: false,
  });
  const cli = statement({ repository: 'https://github.com/ai-ecoverse/slicc-cli' });
  const src = fake({
    attestations: cli,
    statuses: { [COMMIT]: [status()] },
    tags: { certified: '1.44.0' },
  });
  assert.equal((await judge(src, '@ai-ecoverse/wasi-slicc@1.44.7', INTEGRITY)).ok, true);
  const denied = await judge(src, '@ai-ecoverse/wasi-slicc@1.44.4', INTEGRITY);
  assert.equal(denied.ok, false, '1.44.4 never certified, though its commit carries a status');
  assert.match(denied.line, /release run failed/);
  const early = await judge(src, '@ai-ecoverse/wasi-slicc@1.44.0', INTEGRITY);
  assert.equal(early.ok, false, 'before 1.44.1 nothing counts, not even a tag');
  assert.match(
    early.line,
    /pre-PR-cert wasi-slicc \(before 1\.44\.1\), not certified by tag any more/
  );
  assert.equal(
    (
      await judge(
        fake({ attestations: kernelProv, statuses: { [COMMIT]: [status()] } }),
        '@ai-ecoverse/wasi-slicc@1.44.7',
        INTEGRITY
      )
    ).ok,
    false,
    'another repository’s provenance'
  );
});
