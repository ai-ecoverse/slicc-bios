import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLASSES,
  changedPins,
  classOf,
  failedFiles,
  flipOf,
  readingOf,
  scenario,
  scenarioOf,
  shardFlips,
  UNCLASSIFIED,
} from '../../scripts/cert/evidence.mjs';
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
    repository: { full_name: 'ai-ecoverse/slicc-kernel' },
    workflow_url: 'https://api.github.com/repos/ai-ecoverse/slicc-kernel/actions/workflows/1',
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
      'an org-required run of another repository',
      check(),
      run({ repository: { full_name: 'ai-ecoverse/evil' } }),
    ],
    [
      'another repository’s workflow url',
      check(),
      run({ workflow_url: 'https://api.github.com/repos/ai-ecoverse/evil/actions/workflows/1' }),
    ],
    [
      'another ref of the caller',
      check(),
      run({ path: '.github/workflows/cert-review.yml@refs/heads/pr' }),
    ],
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

test('slicc-kernel from ci.yml passes on its commit’s ci / integration and ci / review from a merge_group run of ci.yml on that commit, with no cert-review status', async () => {
  const prov = statement({
    repository: 'https://github.com/ai-ecoverse/slicc-kernel',
    path: '.github/workflows/ci.yml',
  });
  const queued = {
    path: '.github/workflows/ci.yml',
    event: 'merge_group',
    head_sha: COMMIT,
    repository: { full_name: 'ai-ecoverse/slicc-kernel' },
  };
  const check = (name, o = {}) => ({
    name,
    app: { id: 15368 },
    conclusion: 'success',
    details_url: 'https://github.com/ai-ecoverse/slicc-kernel/actions/runs/7/job/70',
    ...o,
  });
  const both = [check('ci / integration'), check('ci / review')];
  const ok = await judge(
    fake({ attestations: prov, checks: { [COMMIT]: both }, runs: { 7: queued } }),
    KERNEL,
    INTEGRITY
  );
  assert.equal(ok.ok, true, ok.line);
  assert.match(
    ok.line,
    /certified at slicc-kernel cccccccccccc: released by \.github\/workflows\/ci\.yml after the merge queue's ci \/ integration and ci \/ review/
  );
  for (const [why, o, re] of [
    ['no checks', { checks: {} }, /has no successful ci \/ integration and ci \/ review/],
    [
      'only ci / integration',
      { checks: { [COMMIT]: [check('ci / integration')] } },
      /has no successful ci \/ review from a merge_group run/,
    ],
    [
      'a failed ci / integration',
      {
        checks: {
          [COMMIT]: [check('ci / integration', { conclusion: 'failure' }), check('ci / review')],
        },
      },
      /has no successful ci \/ integration from/,
    ],
    [
      'a skipped ci / integration from the push run',
      {
        checks: {
          [COMMIT]: [check('ci / integration', { conclusion: 'skipped' }), check('ci / review')],
        },
      },
      /has no successful ci \/ integration from/,
    ],
    [
      'checks from another app',
      { checks: { [COMMIT]: both.map((c) => ({ ...c, app: { id: 1 } })) } },
      /has no successful/,
    ],
    [
      'a pull_request run',
      { runs: { 7: { ...queued, event: 'pull_request' } } },
      /has no successful/,
    ],
    [
      'a run of another commit',
      { runs: { 7: { ...queued, head_sha: PARENT } } },
      /has no successful/,
    ],
    [
      'a run of another workflow',
      { runs: { 7: { ...queued, path: '.github/workflows/x.yml' } } },
      /has no successful/,
    ],
    [
      'a run in another repository',
      { runs: { 7: { ...queued, repository: { full_name: 'ai-ecoverse/slicc-jsh' } } } },
      /has no successful/,
    ],
    [
      'a details url of another repository',
      {
        checks: {
          [COMMIT]: both.map((c) => ({
            ...c,
            details_url: 'https://github.com/ai-ecoverse/slicc-jsh/actions/runs/7/job/70',
          })),
        },
      },
      /has no successful/,
    ],
    ['a commit off main', { compare: 'diverged' }, /is not on main \(diverged\)/],
    [
      'provenance from a branch',
      {
        attestations: statement({
          repository: 'https://github.com/ai-ecoverse/slicc-kernel',
          path: '.github/workflows/ci.yml',
          ref: 'refs/heads/x',
        }),
      },
      /not main/,
    ],
  ]) {
    const r = await judge(
      fake({ attestations: prov, checks: { [COMMIT]: both }, runs: { 7: queued }, ...o }),
      KERNEL,
      INTEGRITY
    );
    assert.equal(r.ok, false, why);
    assert.match(r.line, re, why);
  }
  const jsh = await judge(
    fake({
      attestations: statement({
        repository: 'https://github.com/ai-ecoverse/slicc-jsh',
        path: '.github/workflows/ci.yml',
      }),
      checks: { [COMMIT]: both },
      runs: { 7: { ...queued, repository: { full_name: 'ai-ecoverse/slicc-jsh' } } },
    }),
    '@ai-ecoverse/slicc-jsh@1.0.0',
    INTEGRITY
  );
  assert.equal(jsh.ok, false);
  assert.match(jsh.line, /not slicc-jsh's release\.yml at main/);
});

test('slicc-cdp passes on its certified tag, or from its ci.yml on its commit’s ci / integration and ci / review from a merge_group run, and on nothing else', async () => {
  const CDP = '@ai-ecoverse/slicc-cdp@1.31.0';
  const repository = 'https://github.com/ai-ecoverse/slicc-cdp';
  const prov = statement({ repository, path: '.github/workflows/ci.yml' });
  const queued = {
    path: '.github/workflows/ci.yml',
    event: 'merge_group',
    head_sha: COMMIT,
    repository: { full_name: 'ai-ecoverse/slicc-cdp' },
  };
  const check = (name) => ({
    name,
    app: { id: 15368 },
    conclusion: 'success',
    details_url: 'https://github.com/ai-ecoverse/slicc-cdp/actions/runs/7/job/70',
  });
  const both = [check('ci / integration'), check('ci / review')];
  const base = { attestations: prov, checks: { [COMMIT]: both }, runs: { 7: queued } };
  const ok = await judge(fake(base), CDP, INTEGRITY);
  assert.equal(ok.ok, true, ok.line);
  assert.match(
    ok.line,
    /certified at slicc-cdp cccccccccccc: released by \.github\/workflows\/ci\.yml after the merge queue's ci \/ integration and ci \/ review/
  );
  const tagged = await judge(fake({ tags: { certified: '1.31.0' } }), CDP, INTEGRITY);
  assert.equal(tagged.ok, true, tagged.line);
  for (const [why, o, re] of [
    ['no checks', { checks: {} }, /has no successful ci \/ integration and ci \/ review/],
    [
      'a pull_request run',
      { runs: { 7: { ...queued, event: 'pull_request' } } },
      /has no successful/,
    ],
    [
      'no provenance',
      { attestations: null },
      /certified is unset, not 1\.31\.0, and it has no npm provenance/,
    ],
    [
      'provenance for another tarball',
      {
        attestations: statement({
          repository,
          path: '.github/workflows/ci.yml',
          digest: 'f'.repeat(128),
        }),
      },
      /names another tarball/,
    ],
    [
      'release.yml with a cert-review status',
      { attestations: statement({ repository }), statuses: { [COMMIT]: [status()] } },
      /not slicc-cdp's \.github\/workflows\/ci\.yml/,
    ],
    [
      'ci.yml of another repository',
      {
        attestations: statement({
          repository: 'https://github.com/ai-ecoverse/slicc-kernel',
          path: '.github/workflows/ci.yml',
        }),
      },
      /not slicc-cdp's/,
    ],
    [
      'provenance from a branch',
      {
        attestations: statement({
          repository,
          path: '.github/workflows/ci.yml',
          ref: 'refs/heads/x',
        }),
      },
      /not main/,
    ],
    ['a commit off main', { compare: 'diverged' }, /is not on main \(diverged\)/],
  ]) {
    const r = await judge(fake({ ...base, ...o }), CDP, INTEGRITY);
    assert.equal(r.ok, false, why);
    assert.match(r.line, re, why);
  }
  const clipboard = await judge(
    fake({
      ...base,
      attestations: statement({
        repository: 'https://github.com/ai-ecoverse/slicc-clipboard',
        path: '.github/workflows/ci.yml',
      }),
    }),
    '@ai-ecoverse/slicc-clipboard@1.0.2',
    INTEGRITY
  );
  assert.equal(clipboard.ok, false, 'only slicc-cdp of the tag writers has a pipeline');
  assert.match(clipboard.line, /npm dist-tag certified is unset, not 1\.0\.2$/);
});

test('kernel also passes on its certified tag; clipboard, tailscale and wasi-slicc only on it', async () => {
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
  assert.deepEqual(
    shardFlips(shards),
    ['test/integration/boot.test.mjs'],
    'the retry flip is kept'
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
  assert.match(
    caller,
    /\n {6}evidence-artifacts: \|\n {8}cert-evidence\n {8}cert-inspect\n {8}integration-\*\n/
  );
  assert.match(caller, /\n {6}evidence-notes: \|\n {8}cert-inspect\/inspect\/\*\*\n/);
  for (const path of ['.github/workflows/**', 'scripts/cert/**', 'scripts/ci/**'])
    assert.ok(caller.includes(`\n        ${path}\n`), path);
  assert.deepEqual(
    [...caller.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]),
    ['AWS_BEARER_TOKEN_BEDROCK']
  );
  assert.match(caller, /^ {2}pull_request_target:\n/m);
  assert.match(caller, /^ {2}merge_group:\n/m);
  assert.doesNotMatch(caller, /^ {2}pull_request:\n/m, 'the bootstrap leg is gone');
  const rerun = read('.github/workflows/cert-rerun.yml');
  assert.match(rerun, /^name: cert-rerun\n/);
  assert.match(rerun, /^ {2}pull_request_target:\n {4}branches: \[main\]\n/m);
  assert.doesNotMatch(rerun, /^ {2}pull_request:\n/m);
  assert.match(rerun, /\n {4}types: \[ready_for_review, labeled, unlabeled, edited\]\n/);
  assert.match(rerun, /\npermissions: \{\}\n/);
  assert.match(
    rerun,
    new RegExp(
      `uses: ai-ecoverse/slicc-shared-web/\\.github/workflows/cert-rerun\\.yml@${uses}\\n {4}permissions:\\n {6}actions: write\\n {4}with:\\n {6}tools-ref: ${uses}\\n`
    )
  );
  assert.doesNotMatch(rerun, /secrets\.|contents:|statuses:|checks:|pull-requests:/);
  assert.match(caller, /\n {6}checks: read\n {6}statuses: write\n/);
  assert.doesNotMatch(caller, /checks: write/);
  assert.doesNotMatch(caller, /workflow_run|claude-code-action|certs\.json/);
});

test('ci / cert evidence runs pull-request code with a read-only token and no secret, and ci / test runs release-state in code', () => {
  const job = ci.slice(ci.indexOf('\n  evidence:\n'), ci.indexOf('\n  ci:\n'));
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {6}issues: read\n {4}env:/);
  assert.doesNotMatch(job, /secrets\.|: write|persist-credentials: true/);
  assert.match(job, /timeout-minutes: 45\n/);
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

test('an upstream org-required merge-group run counts: the ref-pinned path and a required_workflows url', async () => {
  const check = {
    id: 9,
    app: { id: 15368 },
    conclusion: 'success',
    external_id: `v2:group:${COMMIT}:78:1`,
    output: { title: 'group: ok' },
  };
  const run = {
    path: '.github/workflows/cert-review.yml@refs/heads/main',
    event: 'merge_group',
    head_sha: COMMIT,
    name: '',
    repository: { full_name: 'ai-ecoverse/slicc-kernel' },
    workflow_url:
      'https://api.github.com/repos/ai-ecoverse/slicc-kernel/actions/required_workflows/4',
  };
  const r = await judge(
    fake({ attestations: kernelProv, checks: { [COMMIT]: [check] }, runs: { 78: run } }),
    KERNEL,
    INTEGRITY
  );
  assert.equal(r.ok, true, r.line);
});

test('a v2 status (target_url = a run attempt) counts only for a merge_group run of the caller on that commit; a bare status counts only for a repository not yet listed as v2', async () => {
  const { V2_STATUS } = await import('../../scripts/cert/release-state.mjs');
  const url = (id) => `https://github.com/ai-ecoverse/slicc-kernel/actions/runs/${id}/attempts/1`;
  const run = (o = {}) => ({
    path: '.github/workflows/cert-review.yml@refs/heads/main',
    event: 'merge_group',
    head_sha: COMMIT,
    repository: { full_name: 'ai-ecoverse/slicc-kernel' },
    workflow_url:
      'https://api.github.com/repos/ai-ecoverse/slicc-kernel/actions/required_workflows/4',
    ...o,
  });
  const ok = await judge(
    fake({
      attestations: kernelProv,
      statuses: { [COMMIT]: [status({ target_url: url(80) })] },
      runs: { 80: run() },
    }),
    KERNEL,
    INTEGRITY
  );
  assert.equal(ok.ok, true, ok.line);
  assert.match(ok.line, /from merge group run 80/);
  for (const [why, r] of [
    ['a pull_request_target run', run({ event: 'pull_request_target' })],
    ['another workflow', run({ path: '.github/workflows/spoof.yml' })],
    ['another commit', run({ head_sha: 'e'.repeat(40) })],
    ['no such run', null],
  ]) {
    const got = await judge(
      fake({
        attestations: kernelProv,
        statuses: { [COMMIT]: [status({ target_url: url(81) })] },
        runs: { 81: r },
      }),
      KERNEL,
      INTEGRITY
    );
    assert.equal(got.ok, false, why);
  }
  V2_STATUS.add('slicc-kernel');
  try {
    const bare = await judge(
      fake({ attestations: kernelProv, statuses: { [COMMIT]: [status()] } }),
      KERNEL,
      INTEGRITY
    );
    assert.equal(bare.ok, false, 'a repository on v2 needs the run-attempt binding');
  } finally {
    V2_STATUS.delete('slicc-kernel');
  }
});

test('ci / cert inspect runs main’s scripts only: the head is checked out as data, never installed or run', () => {
  const job = ci.slice(ci.indexOf('\n  inspect:\n'), ci.indexOf('\n  evidence:\n'));
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {4}env:/);
  assert.doesNotMatch(job, /secrets\.|: write|persist-credentials: true/);
  assert.doesNotMatch(job, /\(cd head|node head\/|head\/scripts|npx/);
  assert.match(job, /node base\/scripts\/cert\/evidence\.mjs inspect --head head --base base/);
  assert.match(job, /\(cd base && npm ci --ignore-scripts/);
  assert.match(job, /name: cert-inspect\n/);
  const evidence = ci.slice(ci.indexOf('\n  evidence:\n'), ci.indexOf('\n  ci:\n'));
  assert.doesNotMatch(
    evidence,
    /evidence\.mjs inspect|release-state/,
    'nothing upstream-marked is written next to pull-request code'
  );
});

const evidenceScript = fileURLToPath(new URL('../../scripts/cert/evidence.mjs', import.meta.url));

function tree(name, script, file) {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  mkdirSync(join(dir, 'test/integration'), { recursive: true });
  writeFileSync(join(dir, file), '');
  writeFileSync(join(dir, 'runs.js'), script);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, private: true, scripts: { test: 'node runs.js' } })
  );
  return dir;
}
const counting = (fails) =>
  `const fs=require('fs');const n=Number(fs.existsSync('n')?fs.readFileSync('n','utf8'):0)+1;fs.writeFileSync('n',String(n));process.exit((${fails})(n)?1:0);`;

function evidenceCmd(cmd, head, base, out) {
  const r = spawnSync(
    process.execPath,
    [evidenceScript, cmd, '--head', head, '--base', base, '--out', out, '--times', '3'],
    { encoding: 'utf8' }
  );
  return { code: r.status, out: r.stdout + r.stderr };
}

function rerun(headScript, baseScript, planExtra = {}, file = 'test/integration/ruby.test.mjs') {
  const head = tree('head', headScript, file);
  const base = tree('base', baseScript, file);
  const out = mkdtempSync(join(scratch, 'out-'));
  writeFileSync(
    join(out, 'plan.json'),
    JSON.stringify({
      failed: [file],
      scenarios: [],
      deadline: Date.now() + 600000,
      ...planExtra,
    })
  );
  evidenceCmd('reruns', head, base, out);
  const row = JSON.parse(readFileSync(join(out, 'reruns.json'), 'utf8')).rows[0];
  return { ...row, check: evidenceCmd('check', head, base, out) };
}

const always = counting('() => true');
const never = counting('() => false');

test('reruns: the head until it passes, main only when the head failed every time, and a known flaky file skipped', () => {
  const regression = rerun(always, never);
  assert.deepEqual(
    [regression.head.length, regression.base.length, regression.outcome, regression.reading],
    [3, 3, 'fail', 'regression: fails every time on the head, passes on main']
  );
  const both = rerun(always, always);
  assert.deepEqual([both.base.length, both.outcome], [1, 'main-alike']);
  const known = rerun(always, never, { flaky: { 'test/integration/ruby.test.mjs': 42 } });
  assert.deepEqual(
    [known.head.length, known.outcome, known.reading],
    [0, 'known-flaky', 'known flaky (issue #42), not re-run']
  );
  assert.equal(regression.check.code, 0, regression.check.out);
});

test('reruns (2a): a shard failure then a passing re-run is a head flake, a finding, and a fail when the file covers data integrity, security or the guard', () => {
  const flake = rerun(never, never);
  assert.deepEqual([flake.head.length, flake.base.length, flake.outcome], [1, 0, 'finding']);
  assert.match(
    flake.reading,
    /^head flake: failed in its shard, then passed 1 of 1 re-runs \(a finding\)$/
  );
  assert.doesNotMatch(flake.reading, /^passes/);
  const later = rerun(counting('(n) => n === 1'), never);
  assert.deepEqual([later.head.length, later.outcome], [2, 'finding']);
  assert.deepEqual(flipOf('test/integration/ruby.test.mjs', null, undefined).outcome, 'finding');
  assert.deepEqual(flipOf('test/integration/vault.test.mjs', 'security', 3).outcome, 'fail');
  assert.deepEqual(flipOf('test/integration/ruby.test.mjs', null, 3).outcome, 'known-flaky');
  const vault = rerun(never, never, {}, 'test/integration/vault.test.mjs');
  assert.deepEqual([vault.class, vault.outcome], ['security', 'fail']);
  assert.match(vault.reading, /it covers security: a fail/);
  for (const [f, c] of [
    ['guard-vectors', 'guard'],
    ['pins', 'guard'],
    ['update', 'data integrity'],
    ['link', 'security'],
  ])
    assert.equal(classOf(`test/integration/${f}.test.mjs`), c);
  assert.equal(classOf('test/integration/ruby.test.mjs'), null);
});

test('reruns (2c): a known flaky-test issue does not skip a file that covers data integrity, security or the guard; the issue is still listed', () => {
  const file = 'test/integration/guard-vectors.test.mjs';
  const row = rerun(always, never, { flaky: { [file]: 7 } }, file);
  assert.deepEqual([row.issue, row.head.length, row.outcome], [7, 3, 'fail']);
});

test('reruns (4): a spent budget is incomplete, and `check` fails the evidence job on it; ci / test needs the evidence job and fails unless it succeeded', () => {
  const late = rerun(always, never, { deadline: Date.now() - 1 });
  assert.deepEqual([late.head.length, late.outcome], [0, 'incomplete']);
  assert.equal(late.check.code, 1);
  assert.match(
    late.check.out,
    /cert evidence: INCOMPLETE test\/integration\/ruby\.test\.mjs: incomplete: the evidence budget ran out on the head/
  );
  const f = { exit: 1 };
  const cut = { exit: 128, timedOut: true };
  assert.equal(
    readingOf({ head: [f, f, f], base: [cut], inBase: true }, 3).outcome,
    'incomplete',
    'a main run the budget killed is not "fails on main alike"'
  );
  assert.equal(readingOf({ head: [f, cut], base: [], inBase: true }, 3).outcome, 'incomplete');
  assert.equal(
    readingOf({ head: [f, f, f], base: [{ exit: 0 }], inBase: true }, 3).outcome,
    'incomplete'
  );
  const head = tree('head', always, 'test/integration/ruby.test.mjs');
  const out = mkdtempSync(join(scratch, 'out-'));
  writeFileSync(
    join(out, 'plan.json'),
    JSON.stringify({ failed: ['test/integration/ruby.test.mjs'], scenarios: [], deadline: 0 })
  );
  const missing = evidenceCmd('check', head, head, out);
  assert.equal(missing.code, 1, 'no reruns.json is incomplete too');
  writeFileSync(join(out, 'reruns.json'), JSON.stringify({ rows: [] }));
  assert.match(evidenceCmd('check', head, head, out).out, /ruby\.test\.mjs: no re-run row/);
  writeFileSync(
    join(out, 'reruns.json'),
    JSON.stringify({ rows: [{ file: 'test/integration/ruby.test.mjs', outcome: 'pass' }] })
  );
  assert.match(evidenceCmd('check', head, head, out).out, /no known outcome/);
  writeFileSync(
    join(out, 'plan.json'),
    JSON.stringify({ failed: [], scenarios: [{ name: 'x', present: true }], deadline: 0 })
  );
  writeFileSync(
    join(out, 'scenarios.json'),
    JSON.stringify([
      { package: 'x@1', head: { skipped: 'the evidence budget ran out' }, incomplete: true },
    ])
  );
  assert.equal(evidenceCmd('check', head, head, out).code, 1, 'a skipped scenario is incomplete');
  const job = ci.slice(ci.indexOf('\n  evidence:\n'), ci.indexOf('\n  ci:\n'));
  assert.match(job, /\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}run: \|\n/);
  assert.match(
    job,
    /if grep -q "reruns, scenarios, check }" base\/scripts\/cert\/evidence\.mjs; then t=base; else t=head; fi\n {10}node "\$t\/scripts\/cert\/evidence\.mjs" check /
  );
  assert.match(
    read('scripts/cert/evidence.mjs'),
    /const run = \{ plan, inspect, reruns, scenarios, check \}\[command\];/,
    'main’s check is found once this merges'
  );
  const test_ = ci.slice(ci.indexOf('\n  ci:\n'));
  assert.match(test_, /needs: \[plan, lint, integration, vendors, evidence\]/);
  assert.match(test_, /EVIDENCE: \$\{\{ needs\.evidence\.result \}\}/);
  assert.match(
    test_,
    /\*\) echo "ci \/ cert evidence: \$EVIDENCE \(incomplete evidence is not a pass\)"; exit 1 ;;/
  );
});

test('#684: the inspect diffs (wasm strings with bidi and zero-width controls) sit under the caller’s evidence-notes, in cert-inspect, which runs no pull-request code', () => {
  const notes = caller
    .match(/\n {6}evidence-notes: \|\n((?: {8}.+\n)+)/)[1]
    .trim()
    .split(/\s+/);
  const glob = (g) =>
    new RegExp(
      `^${g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')}$`
    );
  const path = 'cert-inspect/inspect/_ai-ecoverse_wasm-tailscale-1.104.1-9-1.104.1-11.diff';
  assert.ok(
    notes.some((g) => glob(g).test(path)),
    notes.join(' ')
  );
  assert.ok(
    !notes.some((g) => glob(g).test('cert-evidence/inspect/x.diff')),
    'nothing in the job that runs pull-request code'
  );
});

test('a test file in no class and not on the unclassified list (a new one) counts as a class until the bios coordinator places it: never skipped, a flake is a fail', () => {
  assert.equal(classOf('test/integration/brand-new.test.mjs'), 'an unclassified new file');
  for (const n of UNCLASSIFIED) assert.equal(classOf(`test/integration/${n}.test.mjs`), null, n);
  const both = Object.values(CLASSES)
    .flat()
    .filter((n) => UNCLASSIFIED.includes(n));
  assert.deepEqual(both, []);
  const listed = new Set([...Object.values(CLASSES).flat(), ...UNCLASSIFIED]);
  const files = readdirSync(new URL('./', import.meta.url)).filter((f) => f.endsWith('.test.mjs'));
  const fresh = files.map((f) => f.replace(/\.test\.mjs$/, '')).filter((n) => !listed.has(n));
  if (fresh.length) console.log(`not yet classified (treated as a class): ${fresh.join(', ')}`);
});

test('#705: a stale-branch PR that touches only a test passes against the merge ref’s first parent, and the cdp tag moving past main’s own pin never fails it', async () => {
  const { dir, git, write } = repo();
  const lock = (v) => npmLock([['@ai-ecoverse/slicc-cdp', v, INTEGRITY]]);
  write('src/packages/package-lock.json', lock('1.30.9'));
  write('src/packages/certs.json', '{}\n');
  write('test/integration/a.test.mjs', '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'main 1');
  const stale = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write('test/integration/a.test.mjs', 'export {};\n');
  git('commit', '-q', '-am', 'only a test');
  git('checkout', '-q', '-');
  write('src/packages/package-lock.json', lock('1.30.10'));
  git('commit', '-q', '-am', 'main 2: cdp 1.30.10, certified then');
  git('merge', '-q', '--no-ff', '-m', 'the merge ref', 'pr');
  const src = fake({ tags: { certified: '1.30.14' } });
  const old = await releaseState({ cwd: dir, base: stale, head: 'HEAD', src });
  assert.equal(old.ok, false, 'the payload’s stale base.sha sees main’s own move as the PR’s');
  const r = await releaseState({ cwd: dir, base: git('rev-parse', 'HEAD^1'), head: 'HEAD', src });
  assert.deepEqual(
    [r.ok, r.line],
    [true, 'release-state: PASS no gated pin or certs.json line changes']
  );
  const step = ci.slice(ci.indexOf('(release-state)'), ci.indexOf('(release-state)') + 1200);
  assert.match(
    step,
    /if \[ "\$GITHUB_EVENT_NAME" = pull_request \]; then\n {12}git fetch -q --no-tags --depth=2 origin "\$GITHUB_SHA"\n {12}BASE=\$\(git rev-parse "\$GITHUB_SHA\^1"\)/
  );
  assert.doesNotMatch(step, /pull_request\.base\.sha/);
});

test('#693: inspect and the evidence read main as GitHub merged it (the merge ref’s first parent), so main’s own package moves since a stale base.sha are never the PR’s', () => {
  const jobOf = (name) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return ci.slice(start, start + 1 + next);
  };
  for (const job of ['inspect', 'evidence']) {
    const body = jobOf(job);
    assert.match(body, /ref: \$\{\{ github\.sha \}\}\n {10}fetch-depth: 2\n {10}path: base\n/, job);
    assert.match(body, /run: git -C base checkout -q --detach HEAD\^1\n/, job);
    assert.doesNotMatch(body, /pull_request\.base\.sha|pull_request\.head\.sha/, job);
  }
  assert.match(
    jobOf('inspect'),
    /\(cd base && node scripts\/cert\/release-state\.mjs --base HEAD --head "\$GITHUB_SHA" --out "\$out\/release-state\.json" --no-fail\)/
  );
});

test('#693: a PR whose base is behind main, with no package changes, is not judged on main’s package changes (changedPins on the merge ref and its first parent)', () => {
  const { dir, git, write } = repo();
  const pkg = (v) => JSON.stringify({ dependencies: { '@ai-ecoverse/slicc-browsers': v } });
  write('src/packages/package.json', pkg('1.9.0'));
  write('test/integration/a.test.mjs', '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'main 1');
  const stale = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write('test/integration/a.test.mjs', 'export {};\n');
  git('commit', '-q', '-am', 'only a test');
  git('checkout', '-q', '-');
  write('src/packages/package.json', pkg('1.10.3'));
  git('commit', '-q', '-am', 'main 2: browsers 1.10.3');
  git('merge', '-q', '--no-ff', '-m', 'the merge ref', 'pr');
  const at = (ref) => {
    const wt = mkdtempSync(join(scratch, 'wt-'));
    git('worktree', 'add', '-q', '--detach', wt, ref);
    return wt;
  };
  const merged = at('HEAD');
  assert.equal(changedPins(at(stale), merged).length, 1, 'a stale base sees main’s own move');
  assert.deepEqual(changedPins(at('HEAD^1'), merged), []);
});
