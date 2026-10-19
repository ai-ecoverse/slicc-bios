import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { claims, verify } from '../../scripts/cert/verify.mjs';

const name = '@ai-ecoverse/wasm-bzip2';
const version = '1.0.8-2';
const sha256 = 'eff7f59d50f541f9a1abd352893255de875859b4b58928148799af8ff7c3150d';
const integrity =
  'sha512-FzE8FE3sMzOQLwm3hV1SFW717mhSjjrchGOgFuZW8JCZ57oPs6gJ/915POb5DHsjv3luXKnd2uycKdlOsdZoEQ==';
const clean = [
  `**Cert review: ${name}@${version}** (from 1.0.8-1)`,
  '| Check | Result |',
  `certified ${name}@${version} sha256=${sha256} (ci: https://github.com/ai-ecoverse/slicc-bios/actions/runs/1)`,
  `certs.json: "${name}@${version}": { "integrity": "${integrity}", "sha256": "${sha256}" }`,
].join('\n');

test('the claims parser reads the certified, cert-ci and certs.json lines', () => {
  const text = `${clean}\ncert-ci: PASS @ai-ecoverse/slicc-cdp@1.11.2 sha256=${'b'.repeat(64)} (ci: x), runner cert required\ncert-ci: FAIL @ai-ecoverse/slicc-kernel@1.78.0: grep exits 70`;
  assert.deepEqual(claims(text), [
    { name, version, sha256: [sha256], integrity: [integrity] },
    { name: '@ai-ecoverse/slicc-cdp', version: '1.11.2', sha256: ['b'.repeat(64)], integrity: [] },
  ]);
});

const lookup = async () => ({ sha256, integrity, published: integrity });

test('the sha check passes a verdict whose lines match the tarball', async () => {
  assert.deepEqual(await verify(clean, lookup), { checked: [`${name}@${version}`], problems: [] });
});

test('the sha check withholds a wrong sha256 and a wrong integrity', async () => {
  const wrong = clean.replaceAll(sha256, 'a'.repeat(64)).replace(integrity, 'sha512-AAAA');
  const { problems } = await verify(wrong, lookup);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /sha256 a{64} is not the tarball's/);
  assert.match(problems.at(-1), /integrity sha512-AAAA is not the tarball's/);
});

test('the sha check refuses a tarball that does not match the registry', async () => {
  const { problems } = await verify(clean, async () => ({
    sha256,
    integrity,
    published: 'sha512-other',
  }));
  assert.deepEqual(problems, [
    `${name}@${version}: the tarball doesn't match the registry's integrity`,
  ]);
});

test('the sha check reads the real registry tarball', async () => {
  assert.deepEqual(await verify(clean), { checked: [`${name}@${version}`], problems: [] });
});

const run = promisify(execFile);

async function certScript() {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  );
  return manifest.scripts['test:cert'];
}

async function slowProject(script, ms) {
  const dir = await mkdtemp(join(tmpdir(), 'cert-budget-'));
  const scripts = { 'test:cert': script };
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'cert-budget', private: true, scripts })
  );
  const harness = join(dir, 'node_modules/@ai-ecoverse/slicc-shared-web/harness');
  await mkdir(harness, { recursive: true });
  await writeFile(join(harness, 'global.mjs'), 'export async function globalSetup() {}\n');
  await mkdir(join(dir, 'test/integration'), { recursive: true });
  await writeFile(
    join(dir, 'test/integration/cert.test.mjs'),
    `import { test } from 'node:test';\ntest('a slow sweep', { timeout: Infinity }, () => new Promise((done) => setTimeout(done, ${ms})));\n`
  );
  return dir;
}

async function sweep(dir, budget) {
  const env = { ...process.env, CERT_BUDGET: String(budget) };
  delete env.NODE_TEST_CONTEXT;
  try {
    await run('npm', ['run', '-s', 'test:cert'], { cwd: dir, env });
    return 0;
  } catch (error) {
    return error.code;
  }
}

test('the cert sweep runs under its own budget, not npm test’s 15-minute cap', async (t) => {
  const script = await certScript();
  assert.doesNotMatch(script, /--test-timeout=900000/);
  const fallback = Number(/--test-timeout=\$\{CERT_BUDGET:-(\d+)\}/.exec(script)?.[1]);
  assert.ok(fallback > 900000, `the default budget ${fallback} is longer than npm test's cap`);
  const dir = await slowProject(script, 1500);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await sweep(dir, 500), 1, 'a budget shorter than the sweep cuts it');
  assert.equal(await sweep(dir, 6000), 0, 'a budget longer than the sweep lets it finish');
});

test('a cert review with no verdict, a FAIL, a package without its result line or a sha mismatch fails the check; only a certified line for every package passes', async () => {
  const { verdictOf } = await import('../../scripts/cert/verify.mjs');
  assert.deepEqual(verdictOf(''), { ok: false, line: 'cert-review: FAIL no verdict' });
  assert.deepEqual(verdictOf('**Cert review:** no verdict. See https://example.test/run'), {
    ok: false,
    line: 'cert-review: FAIL no verdict',
  });
  assert.deepEqual(verdictOf(clean), {
    ok: true,
    line: `cert-review: CERTIFIED ${name}@${version}`,
  });
  assert.deepEqual(verdictOf(clean, ['bad sha']), {
    ok: false,
    line: 'cert-review: FAIL sha check: bad sha',
  });
  const failed = `**Cert review: ${name}@${version}** (from 1.0.8-1)\ncert-ci: FAIL ${name}@${version}: the regression test fails`;
  assert.deepEqual(verdictOf(failed), {
    ok: false,
    line: `cert-review: FAIL ${name}@${version} FAIL`,
  });
  const two = `${clean}\n**Cert review: @ai-ecoverse/wasm-xz@5.8.1-2** (from 5.8.1-1)\n| Check | Result |`;
  assert.deepEqual(verdictOf(two), {
    ok: false,
    line: 'cert-review: FAIL @ai-ecoverse/wasm-xz@5.8.1-2 has no certified or cert-ci line',
  });
});

test('the cert review job ends with the verdict check, so a review that writes nothing turns it red', async () => {
  const yml = await readFile(
    new URL('../../.github/workflows/cert-review.yml', import.meta.url),
    'utf8'
  );
  const certify = yml.slice(yml.indexOf('\n  certify:'), yml.indexOf('\n  post:'));
  const last = certify.trimEnd().split('\n      - ').at(-1);
  assert.match(last, /if: always\(\)/);
  assert.match(
    last,
    /node base\/scripts\/cert\/verify\.mjs --verdict "\$RUNNER_TEMP\/cert-review\/comment\.md"/
  );
});

test('no step that runs pull-request code holds a token that can write: the review job is read-only, CI evidence is fetched before npm ci, and a separate job posts the verdict', async () => {
  const yml = await readFile(
    new URL('../../.github/workflows/cert-review.yml', import.meta.url),
    'utf8'
  );
  const certify = yml.slice(yml.indexOf('\n  certify:'), yml.indexOf('\n  post:'));
  const post = yml.slice(yml.indexOf('\n  post:'));
  assert.match(certify, /\n {4}permissions:\n {6}actions: read\n {6}contents: read\n {4}outputs:/);
  assert.doesNotMatch(certify, /: write/);
  assert.doesNotMatch(certify, /\n {6}GH_TOKEN:/);
  assert.doesNotMatch(certify, /gh pr comment/);
  const fetch = certify.indexOf(
    "- name: gh, and CI's results on the head and on main, fetched before any pull-request code runs"
  );
  const install = certify.indexOf("- name: Install both trees and the harness's Chromium");
  assert.ok(fetch > 0 && install > fetch, 'the token step comes before npm ci');
  assert.equal(
    certify.split('GH_TOKEN: ${{ github.token }}').length - 1,
    1,
    'only the fetch step gets the token'
  );
  assert.match(post, /\n {4}permissions:\n {6}contents: read\n {6}pull-requests: write\n/);
  assert.match(post, /artifact-ids: \$\{\{ needs\.certify\.outputs\.evidence_id \}\}/);
  assert.match(post, /digest-mismatch: error/);
  assert.doesNotMatch(post, /ref: \$\{\{ needs\.plan\.outputs\.head \}\}/);
  assert.doesNotMatch(post, /npm (ci|install|test|run)/);
});
