import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ci = await read('.github/workflows/ci.yml');
const pkg = JSON.parse(await read('package.json'));
const input = (name) => ci.match(new RegExp(`\\n {6}${name}: (.+)\\n`))?.[1];
const block = (name) => ci.match(new RegExp(`\\n {6}${name}: \\|\\n((?: {8}.*\\n)+)`))?.[1];

test('CI is one caller of slicc-shared-web pipeline.yml, at the release of the harness the tests use; and the only workflow', async () => {
  assert.deepEqual(await readdir(new URL('../../.github/workflows/', import.meta.url)), ['ci.yml']);
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

test('the pipeline picks its runners and reviews no Renovate pull request', () => {
  for (const name of ['runs-on', 'review-renovate']) assert.equal(input(name), undefined, name);
  assert.doesNotMatch(ci, /vars\./);
  assert.equal(input('shards'), '14');
  assert.equal(input('timeout-minutes'), '90');
  assert.match(input('review-prompt'), /^\|$/);
});

test('the review prompt judges a dependency-only pull request on the suite and provenance, denying only a concrete defect', () => {
  const prompt = ci.slice(ci.indexOf('review-prompt: |'));
  assert.match(
    prompt,
    / {8}Dependency-only pull requests \(Renovate's, or a pin bump that changes only package\.json and lockfiles\): bios tests how seven wires a dependency in, not the dependency's own features \(#771\)\./
  );
  assert.match(prompt, /Don't ask for new tests of what the dependency does;/);
  assert.match(
    prompt,
    /Deny one only for a concrete defect: a test that fails, or is flaky, on the head because of the bump; a bios call site the bump breaks \(an API bios uses that was removed or changed\); a provenance or integrity mismatch; or a new install script\./
  );
  assert.match(prompt, /Notes, and anything you can't judge, are comments, never a denial\./);
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

test('seven is published only after a release, from the production environment, with the deploy token and nothing else', () => {
  assert.equal(input('release-environment'), 'production');
  assert.equal(input('release-secrets'), 'SLICC_BIOS_DEPLOY_TOKEN');
  const after = block('after-release');
  assert.ok(after, 'after-release is a block');
  assert.match(after, /\$RELEASE_VERSION/);
  assert.match(after, /: "\$\{SLICC_BIOS_DEPLOY_TOKEN:\?/);
  assert.match(
    after,
    /\n {8}CLOUDFLARE_API_TOKEN="\$SLICC_BIOS_DEPLOY_TOKEN" node edge\/publish\.mjs main >> "\$GITHUB_STEP_SUMMARY"\n$/
  );
  assert.doesNotMatch(ci, /secrets\./);
});

test('a pull request publishes its preview through the OIDC route in the pipeline’s deploy job, which gets no secret', () => {
  assert.equal(input('deploy'), 'node edge/publish.mjs preview >> "$GITHUB_STEP_SUMMARY"');
  assert.equal(input('deploy-secrets'), undefined);
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
  for (const line of ci.split('\n')) if (/^\s*#/.test(line)) assert.match(line, /^\s*# renovate:/);
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
