import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalRecord } from './guard-bisect-reporter.mjs';

const heads = new Set([
  '17fba4f3e5234d98efcad520760dcabc3ed4942c',
  'a20f97e9963a83460ef44d0cebeacf723201fd53',
  '3ee6446b97b4b37d959a1f7ae46acfb171132e3b',
  'd95aced63ec487c83441d90a6043b91abecdc3b2',
  '7eab01239b24c80adc88d54e3fab83321941e360',
  'ce49c1a63774b2c31b7cd62c3732030678a9e6cf',
  'b99352408f30961a6d057250d936cc42c539b06c',
  '1f2d42eb5264a3a8712f38cff1d5a8f5abdc3eb6',
]);
const head = process.env.BISECT_HEAD;
if (!heads.has(head)) throw new Error('unknown bisect head');
const cases = [
  [
    'test/integration/cdp-link-worlds.test.mjs',
    'kernel facade and slicc-cli link drive ordinary tabs',
    ['link-worlds'],
  ],
  [
    'test/integration/cdp.test.mjs',
    'the guard keeps seven|real slicc-extension.*opaque origin|headed, on the (proxy|link) path: a tab created through the guard with an empty URL',
    ['framed-vault', 'real-extension', 'popup-driving'],
  ],
  ['test/integration/sign-in-held.test.mjs', 'sign-in tabs and their lineage', ['noopener']],
  [
    'test/integration/guard-vectors.test.mjs',
    'wipes in place to the blocked data page',
    ['wipe-driving'],
  ],
  [
    'test/integration/guard-redirect.test.mjs',
    'redirect to seven or the vault',
    ['redirect-observers'],
  ],
  [
    'test/integration/guard-set-proxy-rest.test.mjs',
    'the shared guard vectors|the shared set is complete',
    ['shared-vectors'],
  ],
  [
    'test/integration/guard-set-link-rest.test.mjs',
    'the shared guard vectors|the shared set is complete',
    ['shared-vectors'],
  ],
];
const ids = new Set([
  'C8.newtab',
  'C8.iframe-error',
  'C8.network-error',
  'C2.redirect-body',
  'C2.redirect-secret-mix',
  'C2.redirect-secret',
  'C2.chain-301-302-303',
  'C2.chain-307-308-302',
  'C2.chain-303-301-308',
  'C2.post-307-308',
  'C2.post-308-307',
  'C2.through-302',
  'C2.through-307',
  'C2.302',
  'C2.307',
  'C2.twohop',
  'C3.popup-self-nav',
  'C3.popup-on-redirect-302',
  'C3.popup-on-redirect-chain',
  'C3.direct-popup-stays-out',
]);
const targetKinds = new Set([
  'own',
  'ordinary',
  'chrome-newtab',
  'chrome-new-tab-page',
  'network-error',
]);
const variants = new Set(['prompt', 'lagging']);
const statuses = new Set(['pass', 'fail', 'skip']);
const output = resolve(process.env.BISECT_OUTPUT);
const privateReport = resolve(process.env.RUNNER_TEMP, 'guard-bisect-private-report.json');
const reporter = fileURLToPath(new URL('./guard-bisect-reporter.mjs', import.meta.url));
mkdirSync(output, { recursive: true });
const results = [];
const start = Date.now();
const budget = 2 * 60 * 60 * 1000;

function vectors() {
  if (!existsSync(privateReport)) return [];
  const raw = JSON.parse(readFileSync(privateReport, 'utf8'));
  rmSync(privateReport, { force: true });
  return (raw.results ?? [])
    .filter((row) => ids.has(row.id) && targetKinds.has(row.target) && variants.has(row.variant))
    .map((row) => ({
      id: row.id,
      target: row.target,
      variant: row.variant,
      control: statuses.has(row.control) ? row.control : null,
      guarded: statuses.has(row.guarded) ? row.guarded : null,
      live: statuses.has(row.live) ? row.live : null,
    }));
}

async function run(file, pattern, expected) {
  if (!existsSync(file))
    return { file, code: 1, reason: 'missing-required-file', records: [], vectors: [] };
  const remaining = budget - (Date.now() - start);
  if (remaining <= 0)
    return { file, code: 1, reason: 'head-budget-exhausted', records: [], vectors: [] };
  rmSync(privateReport, { force: true });
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      `--test-timeout=${Math.min(remaining, 3600000)}`,
      '--test-global-setup=test/integration/global.mjs',
      `--test-name-pattern=${pattern}`,
      `--test-reporter=${reporter}`,
      file,
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        SLICC_INSTALL_TRACE: '0',
        SLICC_COVERAGE: '0',
        SLICC_PROFILE: '0',
        GUARD_IDS: [...ids].join(','),
        GUARD_TARGETS: [...targetKinds].join(','),
        GUARD_VARIANTS: [...variants].join(','),
        GUARD_REPORT: privateReport,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );
  let safe = '';
  child.stdout.on('data', (chunk) => {
    safe += chunk;
  });
  child.stderr.on('data', () => {});
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, remaining);
  const code = await new Promise((done) => {
    child.once('error', () => done(1));
    child.once('exit', (value) => done(value ?? 1));
  });
  clearTimeout(timer);
  const records = safe.split('\n').flatMap((line) => {
    try {
      const record = canonicalRecord(JSON.parse(line));
      return record ? [record] : [];
    } catch {
      return [];
    }
  });
  const seen = new Set(
    records.filter((record) => record.point === 'test.result').map((record) => record.family)
  );
  const missing = expected.filter((family) => !seen.has(family));
  const selected = vectors();
  const absentVectors = file.includes('guard-set') && selected.length === 0;
  const notRun = records.some((record) => record.status === 'not-run');
  const vectorFailure = selected.some(
    (row) => row.control !== 'pass' || row.guarded !== 'pass' || row.live !== 'pass'
  );
  return {
    file,
    code:
      code === 0 && !expired && !missing.length && !absentVectors && !notRun && !vectorFailure
        ? 0
        : 1,
    expired,
    missing,
    absentVectors,
    notRun,
    vectorFailure,
    records,
    vectors: selected,
  };
}

for (const [file, pattern, expected] of cases) {
  try {
    results.push(await run(file, pattern, expected));
  } catch {
    results.push({ file, code: 1, reason: 'runner-summary-error', records: [], vectors: [] });
  }
  writeFileSync(
    resolve(output, 'summary.json'),
    `${JSON.stringify({ head, attempts: 1, results }, null, 2)}\n`
  );
  console.log(JSON.stringify({ head, file, code: results.at(-1).code }));
}
rmSync(privateReport, { force: true });
process.exitCode = results.some((result) => result.code !== 0) ? 1 : 0;
