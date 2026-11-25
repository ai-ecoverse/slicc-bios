import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summary } from '@ai-ecoverse/slicc-browsers/guard-runner';

const root = dirname(fileURLToPath(import.meta.url));
const set = JSON.parse(
  readFileSync(
    join(root, '../../node_modules/@ai-ecoverse/slicc-browsers/guard-vectors.json'),
    'utf8'
  )
);

const CLOSE_REFUSED_IDS = [
  'C8.protected-document-restore',
  'C8.protected-error-page-sticky',
  'C8.protected-error-page-sticky.query',
  'C8.protected-error-page-sticky.fragment',
];

const textIds = set.vectors
  .filter((v) => v.kind === 'text' && v.targets.includes('seven'))
  .map((v) => v.id);

function coveredSeven(ids = CLOSE_REFUSED_IDS) {
  const keep = new Set([...ids, ...textIds]);
  return {
    ...set,
    variants: { prompt: set.variants.prompt },
    vectors: set.vectors
      .filter((v) => keep.has(v.id) && v.targets.includes('seven'))
      .map((v) => ({ ...v, targets: ['seven'] })),
  };
}

function artifactRows(ids, notSupported) {
  return [
    ...ids.map((id) => ({
      id,
      target: 'seven',
      variant: 'prompt',
      transport: 'cdp',
      control: 'pass',
      guarded: 'pass',
      live: 'pass',
      notSupported: [...notSupported],
    })),
    ...textIds.map((id) => ({
      id,
      target: 'seven',
      variant: 'prompt',
      transport: 'cdp',
      control: 'not-run',
      guarded: 'not-run',
      live: 'not-run',
    })),
  ];
}

test('complete-set summary: closeRefused gated by declared closeProtected is not forged', () => {
  const covered = coveredSeven();
  const results = artifactRows(CLOSE_REFUSED_IDS, ['closeRefused', 'eventsRedacted']);
  const before = summary({
    set: covered,
    results,
    guard: 'slicc-bios/devtools',
    sha: 'artifact',
  });
  const after = summary({
    set: covered,
    results,
    guard: 'slicc-bios/devtools',
    sha: 'artifact',
    capabilities: { closeProtected: true },
  });
  console.log(
    `ROW-OBSERVED summary-capabilities ${JSON.stringify({
      beforeForged: before.forged.length,
      afterForged: after.forged.length,
      beforeWhy: before.forged.map((row) => `${row.id}:${row.why}`),
      afterWhy: after.forged.map((row) => `${row.id}:${row.why}`),
    })}`
  );
  assert.equal(
    before.forged.length,
    4,
    'without declared caps the four closeRefused skips count forged'
  );
  assert.ok(
    before.forged.every((row) => row.why.includes('not-supported:closeRefused')),
    before.forged.map((row) => row.why).join('; ')
  );
  assert.equal(
    after.forged.length,
    0,
    'with closeProtected declared those gated skips are not forged'
  );
  assert.match(after.line, /^GUARD-PASS /);
});

test('mutant: a skip for a capability the path did not declare stays forged', () => {
  const covered = coveredSeven(['C8.protected-document-restore']);
  const results = artifactRows(['C8.protected-document-restore'], ['closeRefused']);
  const report = summary({
    set: covered,
    results,
    guard: 'slicc-bios/devtools',
    sha: 'artifact',
    capabilities: { browserSession: true, browserStorage: true },
  });
  console.log(
    `ROW-OBSERVED summary-capabilities-mutant-undeclared ${JSON.stringify({
      forged: report.forged.length,
      why: report.forged.map((row) => row.why),
    })}`
  );
  assert.equal(report.forged.length, 1);
  assert.match(report.forged[0].why, /not-supported:closeRefused/);
});

test('mutant: a skip for a declared capability the vector text does not allow stays forged', () => {
  const vector =
    set.vectors.find((v) => v.id === 'C9.frame-hidden') ??
    set.vectors.find((v) => (v.requires ?? []).includes('extensionFrame'));
  assert.ok(vector, 'an extensionFrame vector is in the set');
  const covered = {
    ...set,
    variants: { prompt: set.variants.prompt },
    vectors: [{ ...vector, targets: vector.targets.slice(0, 1) }],
  };
  const results = [
    {
      id: vector.id,
      target: covered.vectors[0].targets[0],
      variant: 'prompt',
      transport: 'cdp',
      control: 'skip',
      guarded: 'skip',
      live: 'skip',
      reason: 'not-supported:extensionFrame',
    },
  ];
  const report = summary({
    set: covered,
    results,
    guard: 'slicc-bios/extension',
    sha: 'artifact',
    capabilities: { extensionFrame: true, browserSession: true, browserStorage: true },
  });
  console.log(
    `ROW-OBSERVED summary-capabilities-mutant-declared-absent ${JSON.stringify({
      forged: report.forged.length,
      why: report.forged.map((row) => row.why),
    })}`
  );
  assert.equal(report.forged.length, 1);
  assert.match(report.forged[0].why, /not-supported:extensionFrame while the run declared/);
});
