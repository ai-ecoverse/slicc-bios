import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CORP_OVERRIDE,
  CORP_OVERRIDE_WHY,
  classForPath,
  headersForClass,
  realVault,
  vaultPackageRoot,
} from './real-vault.mjs';

const require = createRequire(import.meta.url);
const pin = require('../../package.json').devDependencies['@ai-ecoverse/slicc-vault'];
const ORIGIN = 'https://seven.example.test';
const HEADER_NAMES = [
  'content-security-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'origin-agent-cluster',
  'x-content-type-options',
  'referrer-policy',
  'cache-control',
  'content-type',
];

function picked(response) {
  return Object.fromEntries(HEADER_NAMES.map((name) => [name, response.headers.get(name)]));
}

function fromHeadersJson(headers, origin) {
  return {
    ...headers,
    'content-security-policy': headers['content-security-policy'].replace(
      /frame-ancestors[^;]*/,
      `frame-ancestors ${origin}`
    ),
    'cross-origin-resource-policy': CORP_OVERRIDE,
  };
}

function writeVaultPackage(dir, { packageVersion, configVersion }) {
  mkdirSync(join(dir, 'dist/site'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: '@ai-ecoverse/slicc-vault', version: packageVersion })}\n`
  );
  writeFileSync(
    join(dir, 'dist/site/config.json'),
    `${JSON.stringify({ version: configVersion, embedders: [] })}\n`
  );
  writeFileSync(join(dir, 'dist/headers.json'), `${JSON.stringify({ classes: {} })}\n`);
}

test('real vault resolves the pinned package without depending on its exports map', () => {
  const root = vaultPackageRoot();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@ai-ecoverse/slicc-vault');
  assert.equal(pkg.version, pin);
  assert.equal(pkg.exports?.['.']?.types, './dist/types/contract.d.ts');
  assert.equal(pkg.exports?.['./dist/site/config.json'], undefined);
});

test('real vault keeps the version mismatch error text', async () => {
  await assert.rejects(() => realVault(ORIGIN, { version: '0.0.0' }), {
    message: `the vault deployment version is ${pin}, expected 0.0.0`,
  });
});

test('real vault serves the package site with headers.json classes and the embedder override', async (t) => {
  const vault = await realVault(ORIGIN, { version: pin });
  t.after(() => vault.close());
  assert.equal(vault.version, pin);
  const probes = [
    join(vault.site, 'probe-class.wasm'),
    join(vault.site, 'probe-class.map'),
    join(vault.site, 'probe-class.txt'),
  ];
  t.after(() => {
    for (const file of probes) rmSync(file, { force: true });
  });
  writeFileSync(probes[0], Buffer.from([0]));
  writeFileSync(probes[1], Buffer.from('{}'));
  writeFileSync(probes[2], Buffer.from('legal\n'));
  const cases = [
    ['/', 'documents'],
    ['/index.html', 'documents'],
    ['/button.html', 'documents'],
    ['/value.html', 'documents'],
    ['/popup.html', 'documents'],
    ['/frame.js', 'scripts'],
    ['/vault.css', 'css'],
    ['/fonts/AdobeClean-Regular.woff2', 'fonts'],
    ['/probe-class.map', 'maps'],
    ['/probe-class.txt', 'text'],
    ['/probe-class.wasm', 'wasm'],
    ['/config.json', 'config.json'],
    ['/embedders.json', 'embedders.json'],
  ];
  const packaged = JSON.parse(readFileSync(join(vaultPackageRoot(), 'dist/headers.json'), 'utf8'));
  for (const [path, name] of cases) {
    assert.equal(classForPath(path, vault.headers.classes)?.name, name, path);
    const response = await fetch(new URL(path, vault.origin));
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, path);
    assert.deepEqual(picked(response), headersForClass(vault.headers.classes[name], ORIGIN), path);
    if (path === '/config.json' || path === '/embedders.json') {
      assert.deepEqual(JSON.parse(body.toString('utf8')), {
        ...JSON.parse(readFileSync(join(vault.site, 'config.json'), 'utf8')),
        embedders: [ORIGIN],
      });
    } else if (path === '/') {
      assert.deepEqual(body, readFileSync(join(vault.site, 'index.html')));
    } else {
      assert.deepEqual(body, readFileSync(join(vault.site, path.slice(1))));
    }
  }
  for (const [path, name] of [
    ['/index.html', 'documents'],
    ['/frame.js', 'scripts'],
    ['/probe-class.wasm', 'wasm'],
  ]) {
    const response = await fetch(new URL(path, vault.origin));
    await response.arrayBuffer();
    assert.deepEqual(
      picked(response),
      fromHeadersJson(packaged.classes[name].headers, ORIGIN),
      path
    );
  }
});

test('real vault serves CORP cross-origin for every class and keeps every other headers.json header', async (t) => {
  assert.match(CORP_OVERRIDE_WHY, /origin-keyed/);
  assert.match(CORP_OVERRIDE_WHY, /same-site/);
  assert.match(CORP_OVERRIDE_WHY, /cross-origin/);
  const vault = await realVault(ORIGIN, { version: pin });
  t.after(() => vault.close());
  const probes = [
    join(vault.site, 'probe-corp.wasm'),
    join(vault.site, 'probe-corp.map'),
    join(vault.site, 'probe-corp.txt'),
  ];
  t.after(() => {
    for (const file of probes) rmSync(file, { force: true });
  });
  writeFileSync(probes[0], Buffer.from([0]));
  writeFileSync(probes[1], Buffer.from('{}'));
  writeFileSync(probes[2], Buffer.from('legal\n'));
  const packaged = JSON.parse(readFileSync(join(vaultPackageRoot(), 'dist/headers.json'), 'utf8'));
  const cases = [
    ['/', 'documents'],
    ['/index.html', 'documents'],
    ['/button.html', 'documents'],
    ['/value.html', 'documents'],
    ['/popup.html', 'documents'],
    ['/frame.js', 'scripts'],
    ['/vault.css', 'css'],
    ['/fonts/AdobeClean-Regular.woff2', 'fonts'],
    ['/probe-corp.map', 'maps'],
    ['/probe-corp.txt', 'text'],
    ['/probe-corp.wasm', 'wasm'],
    ['/config.json', 'config.json'],
    ['/embedders.json', 'embedders.json'],
  ];
  for (const [path, name] of cases) {
    assert.equal(packaged.classes[name].headers['cross-origin-resource-policy'], 'same-site', name);
    const response = await fetch(new URL(path, vault.origin));
    await response.arrayBuffer();
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cross-origin-resource-policy'), CORP_OVERRIDE, path);
    const expected = fromHeadersJson(packaged.classes[name].headers, ORIGIN);
    assert.deepEqual(picked(response), expected, path);
    for (const header of HEADER_NAMES) {
      if (header === 'cross-origin-resource-policy' || header === 'content-security-policy')
        continue;
      assert.equal(
        response.headers.get(header),
        packaged.classes[name].headers[header],
        `${path} ${header}`
      );
    }
  }
});

test('real vault evidence records cold, cached and failed asset loads without their contents', async (t) => {
  const vault = await realVault(ORIGIN, { version: pin });
  t.after(() => vault.close());
  const marker = 'synthetic-content-excluded-from-evidence';
  const probe = join(vault.site, 'probe-evidence.js');
  t.after(() => rmSync(probe, { force: true }));
  writeFileSync(probe, marker);
  for (const path of ['/probe-evidence.js', '/probe-evidence.js', '/missing.js']) {
    const response = await fetch(new URL(path, vault.origin));
    await response.arrayBuffer();
    assert.equal(response.status, path === '/missing.js' ? 404 : 200);
  }
  const evidence = vault.evidence();
  assert.equal(evidence.version, pin);
  assert.equal(evidence.source, vault.site);
  assert.deepEqual(
    evidence.requests.map(({ status }) => status),
    [200, 200, 404]
  );
  assert.deepEqual(
    evidence.requests.map(({ cached }) => cached),
    [false, true, false]
  );
  assert.deepEqual(
    evidence.requests.map(({ upstreamStatus }) => upstreamStatus),
    [200, undefined, 404]
  );
  assert.equal(evidence.requests[2].error, 'Error');
  for (const request of evidence.requests) {
    assert.ok(request.startedAt <= request.finishedAt);
    assert.equal(request.aborted, false);
  }
  assert.equal(JSON.stringify(evidence).includes(marker), false);
  assert.deepEqual(
    evidence.assets.map(({ path }) => path),
    ['/probe-evidence.js']
  );
});

test('real vault answers 404 when a packaged asset is missing', async (t) => {
  const vault = await realVault(ORIGIN, { version: pin });
  t.after(() => vault.close());
  const response = await fetch(new URL('/absent-asset.js', vault.origin));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'the vault deployment is unavailable');
  const [row] = vault.evidence().requests;
  assert.equal(row.status, 404);
  assert.equal(row.upstreamStatus, 404);
  assert.equal(row.error, 'Error');
});

test('real vault answers 404 when a site symlink points outside dist/site', async (t) => {
  const vault = await realVault(ORIGIN, { version: pin });
  t.after(() => vault.close());
  const outside = join(vault.site, '..', 'probe-outside-sentinel.txt');
  const link = join(vault.site, 'probe-outside-link.js');
  t.after(() => {
    rmSync(link, { force: true });
    rmSync(outside, { force: true });
  });
  writeFileSync(outside, 'OUTSIDE-SECRET');
  symlinkSync(outside, link);
  const response = await fetch(new URL('/probe-outside-link.js', vault.origin));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'the vault deployment is unavailable');
  assert.equal(JSON.stringify(vault.evidence()).includes('OUTSIDE-SECRET'), false);
});

test('real vault refuses a nested install and a package.json that disagrees with config.json', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'slicc-bios-vault-root-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: '@ai-ecoverse/slicc-bios', version: '0.0.0' })}\n`
  );
  const rootInstall = join(repo, 'node_modules/@ai-ecoverse/slicc-vault');
  writeVaultPackage(rootInstall, { packageVersion: pin, configVersion: pin });
  const nested = join(repo, 'test/node_modules/@ai-ecoverse/slicc-vault');
  writeVaultPackage(nested, { packageVersion: '8.8.8', configVersion: '8.8.8' });
  assert.equal(vaultPackageRoot(join(repo, 'test/integration')), rootInstall);

  const mismatched = mkdtempSync(join(tmpdir(), 'slicc-bios-vault-mismatch-'));
  t.after(() => rmSync(mismatched, { recursive: true, force: true }));
  writeFileSync(
    join(mismatched, 'package.json'),
    `${JSON.stringify({ name: '@ai-ecoverse/slicc-bios', version: '0.0.0' })}\n`
  );
  writeVaultPackage(join(mismatched, 'node_modules/@ai-ecoverse/slicc-vault'), {
    packageVersion: '0.0.1',
    configVersion: pin,
  });
  assert.throws(() => vaultPackageRoot(join(mismatched, 'test/integration')), {
    message: `the vault package version is 0.0.1, expected ${pin}`,
  });
});
