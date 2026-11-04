import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sum = (data) => createHash('sha256').update(data).digest('hex');
const head = (where) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: where, encoding: 'utf8' }).trim();
const wasmFrom = (file) =>
  execFileSync('tar', ['-xOzf', file, 'package/bin/playwright-cli.wasm'], {
    maxBuffer: 64 * 1024 * 1024,
  });
const verifySource = (source) =>
  execFileSync('git', [
    'diff',
    '--exit-code',
    source,
    '--',
    'src',
    'edge',
    'README.md',
    'package.json',
    'package-lock.json',
  ]);

export function registryProof(data, metadata, name, version, expectedHead) {
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, version);
  if (expectedHead !== undefined) assert.equal(metadata.gitHead, expectedHead);
  assert.equal(
    metadata.dist.integrity,
    `sha512-${createHash('sha512').update(data).digest('base64')}`
  );
  return {
    name,
    version,
    gitHead: metadata.gitHead,
    integrity: metadata.dist.integrity,
    tarball: metadata.dist.tarball,
    provenance: metadata.dist.attestations?.url,
    sha256: sum(data),
    source: 'published npm release, not rebuilt',
  };
}

export async function artifactManifest(directory, config, io = {}) {
  const read = io.readFile ?? readFile;
  const gitHead = io.head ?? head;
  const wasm = io.wasmFrom ?? wasmFrom;
  const verify = io.verifySource ?? verifySource;
  const cdp = `ai-ecoverse-slicc-cdp-${config.cdpVersion}.tgz`;
  const mcpcat = `ai-ecoverse-mcpcat-${config.mcpcatVersion}.tgz`;
  const browsers = `ai-ecoverse-slicc-browsers-${config.browsersVersion}.tgz`;
  const oldClient = `ai-ecoverse-slicc-cdp-${config.oldCdpVersion}.tgz`;
  const proofs = {};
  for (const [key, file, name, version, expected] of [
    ['cdp', cdp, '@ai-ecoverse/slicc-cdp', config.cdpVersion, config.cdp],
    ['mcpcat', mcpcat, '@ai-ecoverse/mcpcat', config.mcpcatVersion, config.mcpcat],
    ['browsers', browsers, '@ai-ecoverse/slicc-browsers', config.browsersVersion, config.browsers],
    ['oldClient', oldClient, '@ai-ecoverse/slicc-cdp', config.oldCdpVersion, undefined],
  ]) {
    proofs[key] = registryProof(
      await read(join(directory, file)),
      JSON.parse(await read(join(directory, `${key}.registry.json`), 'utf8')),
      name,
      version,
      expected
    );
  }
  const heads = { bios: gitHead('.') };
  for (const key of ['cdp', 'mcpcat', 'extension', 'cli', 'browsers']) {
    heads[key] = gitHead(`candidates/${key}`);
    assert.equal(heads[key], config[key]);
  }
  verify(config.biosSource);
  const extensionSha256 = sum(await read(join(directory, 'slicc-extension.zip')));
  const cliSha256 = sum(await read(join(directory, 'slicc-linux-amd64')));
  assert.equal(extensionSha256, config.extensionRelease.sha256);
  assert.equal(cliSha256, config.cliRelease.sha256);
  return {
    heads,
    biosSource: config.biosSource,
    releaseVersions: {
      cdp: config.cdpVersion,
      mcpcat: config.mcpcatVersion,
      extension: config.extensionCandidate ? undefined : config.extensionVersion,
      cli: config.cliVersion,
      browsers: config.browsersVersion,
    },
    candidateVersions: config.extensionCandidate
      ? { extension: config.extensionVersion }
      : undefined,
    cdp,
    mcpcat,
    oldClient,
    browsers,
    browsersDirectory: 'browsers-release',
    oldClientWasmSha256: sum(wasm(join(directory, oldClient))),
    wasmSha256: sum(wasm(join(directory, cdp))),
    packageSha256: {
      cdp: proofs.cdp.sha256,
      mcpcat: proofs.mcpcat.sha256,
      browsers: proofs.browsers.sha256,
    },
    releaseProofs: proofs,
    extension: {
      version: config.extensionVersion,
      sha256: extensionSha256,
      url: config.extensionRelease.url,
      fixture: config.extensionRelease.fixture,
      source: config.extensionCandidate
        ? 'candidate fixture zip at its exact supplied commit and checksum; observational taps only in diagnostic copy'
        : 'released zip; observational taps only in diagnostic copy',
    },
    cli: {
      version: config.cliVersion,
      sha256: cliSha256,
      url: config.cliRelease.url,
      source: 'released Linux amd64 binary, not rebuilt',
    },
    browsersRigHelper: {
      source:
        'byte-identical rig-only bfcache-restore.mjs from candidate 0523b11ff42c9ef41cd997a6a974fd66824ae60f',
      sha256: '6e9439a236b47ccd8479d0b222ff2c5139ae2cc9a512732ccab14071b5751248',
      browserDataVersion: config.browsersVersion,
    },
    sourceCheckouts: config.extensionCandidate
      ? 'extension candidate commit plus exact released tag commits for other components; executed artifacts are the candidate fixture zip and releases, with the explicit rig-only BFCache fixture overlay'
      : 'exact released tag commits for audit and Rust memory preflights only; executed components are release artifacts, with the explicit rig-only BFCache fixture overlay',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  const config = JSON.parse(
    await readFile(new URL('./cdp-675-candidates.json', import.meta.url), 'utf8')
  );
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(await artifactManifest(directory, config), null, 2)
  );
}
