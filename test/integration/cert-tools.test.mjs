import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scan } from '../../scripts/cert/scan.mjs';
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

test('the scanner lets a clean verdict through', () => {
  assert.deepEqual(scan(clean, ['not-in-the-text']), []);
});

test('the scanner withholds a Bedrock-key shape, a GitHub token, a private key and the exact secret', () => {
  assert.deepEqual(scan(`${clean}\nABSKQmVkcm9ja0FQSUtleS1mYWtl`), ['a Bedrock key']);
  assert.deepEqual(scan(`${clean}\nghs_FakeInstallationToken123`), ['a GitHub token']);
  assert.deepEqual(scan(`${clean}\ngithub_pat_11FAKE_abcdefghij`), ['a GitHub token']);
  assert.deepEqual(scan(`${clean}\n-----BEGIN OPENSSH PRIVATE KEY-----`), ['a private key']);
  assert.deepEqual(scan(`${clean}\nkey: fake-secret-7f3a`, ['fake-secret-7f3a']), [
    'a secret value',
  ]);
  assert.deepEqual(scan(clean, ['']), []);
});

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
