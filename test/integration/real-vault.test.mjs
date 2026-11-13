import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { classForPath, headersForClass, realVault, vaultPackageRoot } from './real-vault.mjs';

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
