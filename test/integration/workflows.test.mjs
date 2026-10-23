import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ci = await read('.github/workflows/ci.yml');
const deploy = await read('.github/workflows/deploy.yml');
const pkg = JSON.parse(await read('package.json'));
const input = (name) => ci.match(new RegExp(`\\n {6}${name}: (.+)\\n`))?.[1];

test('CI is one caller of slicc-shared-web pipeline.yml, at the release of the harness the tests use; the only other workflow is the deploy to sliccy.ai', async () => {
  assert.deepEqual(await readdir(new URL('../../.github/workflows/', import.meta.url)), [
    'ci.yml',
    'deploy.yml',
  ]);
  assert.deepEqual(await readdir(new URL('../../.github/', import.meta.url)), ['workflows']);
  const version = pkg.devDependencies['@ai-ecoverse/slicc-shared-web'];
  assert.match(version, /^2\.\d+\.\d+$/);
  assert.match(
    ci,
    new RegExp(
      `\\njobs:\\n {2}ci:\\n {4}uses: ai-ecoverse/slicc-shared-web/\\.github/workflows/pipeline\\.yml@v${version.replaceAll('.', '\\.')}\\n {4}secrets: inherit\\n {4}with:\\n`
    )
  );
  assert.deepEqual(ci.split('\njobs:\n')[1].match(/^ {2}[a-z-]+:$/gm), ['  ci:']);
  assert.doesNotMatch(deploy, /pipeline\.yml|workflow_call|workflow_dispatch|schedule:/);
});

test('CI runs on pull requests, merge groups and pushes to main, and cancels a superseded run only on a pull request', () => {
  assert.match(
    ci,
    /\non:\n {2}pull_request:\n {2}merge_group:\n {2}push:\n {4}branches: \[main\]\n/
  );
  assert.match(
    ci,
    /\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/
  );
  assert.doesNotMatch(ci, /workflow_dispatch|schedule:|workflow_run/);
  assert.match(
    ci,
    /\npermissions:\n {2}contents: write\n {2}actions: read\n {2}attestations: write\n {2}issues: write\n {2}pull-requests: write\n {2}statuses: write\n {2}id-token: write\n/
  );
});

test('the pipeline picks its runners, reviews no Renovate pull request, and nothing runs after a release; the deploy runs on a hosted runner', () => {
  for (const name of [
    'runs-on',
    'after-release',
    'review-renovate',
    'release-environment',
    'deploy',
  ])
    assert.equal(input(name), undefined, name);
  assert.doesNotMatch(ci, /vars\./);
  assert.doesNotMatch(deploy, /vars\./);
  assert.match(deploy, /\n {4}runs-on: ubuntu-latest\n/);
  assert.equal(input('shards'), '12');
  assert.equal(input('timeout-minutes'), '90');
  assert.match(input('review-prompt'), /^\|$/);
});

test('the shards split exactly the files npm test runs, on the Node the package asks for, with Chrome for Testing and no Playwright', () => {
  assert.equal(input('test'), undefined);
  assert.equal(input('test-glob'), 'test/integration/*.test.mjs');
  assert.ok(pkg.scripts.test.endsWith(` '${input('test-glob')}'`), pkg.scripts.test);
  assert.doesNotMatch(pkg.scripts.test, /NODE_OPTIONS/);
  assert.equal(input('node-version'), `'${pkg.engines.node.replace(/^>=/, '')}'`);
  assert.equal(pkg.scripts.pretest, 'slicc-cdp install-browser');
  assert.ok(pkg.devDependencies['@ai-ecoverse/slicc-cdp']);
  assert.equal(pkg.devDependencies['playwright-core'], undefined);
  assert.equal(pkg.devDependencies.puppeteer, undefined);
});

test('semantic-release publishes to npm from the trusted ci.yml, with provenance', async () => {
  assert.equal(pkg.fledgling.workflow, 'ci.yml');
  assert.equal(pkg.fledgling.repo, 'ai-ecoverse/slicc-bios');
  assert.equal(pkg.publishConfig.provenance, true);
  const release = JSON.parse(await read('.releaserc.json'));
  assert.deepEqual(release.branches, ['main']);
  assert.ok(release.plugins.includes('@semantic-release/npm'));
  assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
});

test('the workflows have no comments but renovate annotations', () => {
  for (const line of `${ci}\n${deploy}`.split('\n'))
    if (/^\s*#/.test(line)) assert.match(line, /^\s*# renovate:/);
});

test('the guard-set vectors run as one file per path, target group and detach variant, so the shards can balance them', async () => {
  const { ALL_TARGETS, GROUPS, groupTargets } = await import('./guard-groups.mjs');
  const groups = [...Object.keys(GROUPS), 'rest'];
  assert.deepEqual(groups.flatMap(groupTargets).sort(), [...ALL_TARGETS].sort());
  const files = (await readdir(new URL('./', import.meta.url)))
    .filter((name) => name.startsWith('guard-set-'))
    .sort();
  const want = ['extension', 'proxy', 'link']
    .flatMap((path) =>
      groups.flatMap((group) => [
        `guard-set-${path}-${group}-lagging.test.mjs`,
        `guard-set-${path}-${group}.test.mjs`,
      ])
    )
    .sort();
  assert.deepEqual(files, want);
});
