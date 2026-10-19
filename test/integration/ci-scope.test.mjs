import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { plan } from '../../scripts/ci/plan.mjs';
import { changes, scope, scopes } from '../../scripts/ci/scope.mjs';
import { shardsVerdict } from '../../scripts/ci/verdict.mjs';

const root = new URL('../../', import.meta.url);
const map = await scopes();
const real = (path) => readFile(new URL(path, root), 'utf8');
const base = {
  'README.md': '# bios\n',
  'package.json': await real('package.json'),
  'src/seed/os.js': 'export {};\n',
  'src/packages/package.json': await real('src/packages/package.json'),
  'src/packages/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'src/packages/certs.json': '{}\n',
  'src/packages/optional/catalog.json': await real('src/packages/optional/catalog.json'),
  'test/integration/shell.test.mjs': 'one\n',
  'test/integration/chrome.mjs': 'one\n',
};

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
}

async function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

async function scoped(edit, event = 'pull_request') {
  const dir = await mkdtemp(join(tmpdir(), 'ci-scope-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'ci@example.com');
    git(dir, 'config', 'user.name', 'ci');
    await write(dir, base);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    await write(dir, edit);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'change');
    return scope({ event, ...changes(dir), map });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const bumped = (json, field, name, version) => {
  const parsed = JSON.parse(json);
  parsed[field][name] = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
};

test('a docs-only pull request runs lint alone: no shard and no vendors, and ci / test passes only with both skipped', async () => {
  const docs = await scoped({ 'README.md': '# bios, better\n' });
  assert.equal(docs.mode, 'docs');
  const planned = await plan({ event: 'pull_request', payload: {}, seed: 1, scoped: docs });
  assert.deepEqual(planned.shards, []);
  assert.deepEqual(planned.skip, ['integration', 'vendors']);
  const results = { plan: 'success', lint: 'success', integration: 'skipped', vendors: 'skipped' };
  assert.deepEqual(shardsVerdict([], [], results, { mode: 'docs', skip: planned.skip }), {
    ok: true,
    line: 'ci: PASS docs plan, 0 shards, skipped integration and vendors',
  });
  assert.equal(
    shardsVerdict([], [], { ...results, lint: 'failure' }, { mode: 'docs', skip: planned.skip }).ok,
    false
  );
  assert.equal(shardsVerdict([], [], results).ok, false);
  assert.equal(shardsVerdict([], [], results, { mode: 'full', skip: planned.skip }).ok, false);
});

test("a test-only pull request runs only its changed test files' shards, and a helper change runs everything", async () => {
  const tests = await scoped({ 'test/integration/shell.test.mjs': 'two\n' });
  assert.equal(tests.mode, 'tests');
  assert.deepEqual(tests.rows, ['shell.test.mjs']);
  const planned = await plan({ event: 'pull_request', payload: {}, seed: 1, scoped: tests });
  assert.deepEqual(
    planned.shards.flatMap(({ items }) => items),
    ['test/integration/shell.test.mjs']
  );
  assert.deepEqual(planned.skip, ['vendors']);
  const helper = await scoped({ 'test/integration/chrome.mjs': 'two\n' });
  assert.equal(helper.mode, 'full');
  assert.equal(helper.rows, null);
});

test("a catalog-only pull request runs the pins, optional, catalog and packages rows plus the changed package's own", async () => {
  const catalog = JSON.parse(base['src/packages/optional/catalog.json']);
  catalog['@ai-ecoverse/wasix-perl'].description = 'Perl, described again.';
  const result = await scoped({
    'src/packages/optional/catalog.json': `${JSON.stringify(catalog, null, 2)}\n`,
  });
  assert.equal(result.mode, 'catalog');
  for (const row of ['pins', 'optional', 'packages', 'unshadow', 'perl']) {
    assert.ok(result.rows.includes(`${row}.test.mjs`), row);
  }
  assert.ok(!result.rows.includes('boot.test.mjs'));
});

test("a pin bump runs pins and the boot smoke plus the bumped package's rows, and anything unmapped or beyond the pins runs everything", async () => {
  const kernel = await scoped({
    'src/packages/package.json': bumped(
      base['src/packages/package.json'],
      'dependencies',
      '@ai-ecoverse/slicc-kernel',
      '9.9.9'
    ),
    'src/packages/pnpm-lock.yaml': 'lockfileVersion: 9.0\nchanged: true\n',
    'src/packages/certs.json': '{ "@ai-ecoverse/slicc-kernel@9.9.9": {} }\n',
  });
  assert.equal(kernel.mode, 'bump');
  for (const row of ['pins', 'boot', 'k4', 'one-kernel', 'shell']) {
    assert.ok(kernel.rows.includes(`${row}.test.mjs`), row);
  }
  assert.ok(!kernel.rows.includes('guard-set-proxy.test.mjs'));
  const cdp = await scoped({
    'src/packages/package.json': bumped(
      base['src/packages/package.json'],
      'dependencies',
      '@ai-ecoverse/slicc-cdp',
      '9.9.9'
    ),
  });
  assert.ok(cdp.rows.includes('guard-set-proxy.test.mjs'));
  assert.ok(cdp.rows.includes('cdp.test.mjs'));
  const cli = await scoped({
    'package.json': bumped(base['package.json'], 'devDependencies', '@ai-ecoverse/slicc', '9.9.9'),
  });
  assert.equal(cli.mode, 'bump');
  assert.equal(cli.vendors, true);
  const harness = await scoped({
    'package.json': bumped(
      base['package.json'],
      'devDependencies',
      '@ai-ecoverse/slicc-shared-web',
      '9.9.9'
    ),
  });
  assert.equal(harness.mode, 'full');
  const unknown = await scoped({
    'package.json': bumped(base['package.json'], 'devDependencies', 'left-pad', '1.3.0'),
  });
  assert.equal(unknown.mode, 'full');
  assert.match(unknown.reason, /left-pad has no rows/);
  const script = JSON.parse(base['package.json']);
  script.scripts.lint = 'true';
  assert.equal((await scoped({ 'package.json': JSON.stringify(script) })).mode, 'full');
  const lock = await scoped({ 'src/packages/pnpm-lock.yaml': 'lockfileVersion: 9.0\nx: 1\n' });
  assert.equal(lock.mode, 'full');
  const code = await scoped({
    'src/seed/os.js': 'export const x = 1;\n',
    'README.md': '# bios, better\n',
  });
  assert.equal(code.mode, 'full');
});

test('merge groups, pushes and dispatches always run the full suite, whatever changed', async () => {
  for (const event of ['merge_group', 'push', 'workflow_dispatch']) {
    const result = await scoped({ 'README.md': '# bios, better\n' }, event);
    assert.equal(result.mode, 'full', event);
    const planned = await plan({ event, payload: {}, seed: 1, scoped: result });
    assert.deepEqual(planned.skip, []);
    assert.ok(planned.shards.length > 1);
  }
});
