import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { instrument, sanitize } from './guard-native-diagnostic.mjs';

const directory = resolve('guard-diagnostic');
mkdirSync(directory, { recursive: true });
const restore = instrument();
const selections = [
  {
    group: 'frames',
    file: 'guard-frames.test.mjs',
    pattern: 'frame id the guard never saw|ordinary page.*about:blank.*srcdoc',
  },
  { group: 'parent', file: 'cdp.test.mjs', pattern: 'the guard keeps seven' },
  {
    group: 'proxy-error',
    file: 'guard-set-proxy-rest-lagging.test.mjs',
    pattern: 'the shared guard vectors',
    vectors: true,
  },
  {
    group: 'extension-error',
    file: 'guard-set-extension-rest-lagging.test.mjs',
    pattern: 'the shared guard vectors',
    vectors: true,
  },
  {
    group: 'link-error',
    file: 'guard-set-link-rest-lagging.test.mjs',
    pattern: 'the shared guard vectors',
    vectors: true,
  },
];
const end = Date.now() + 75 * 60 * 1000;
const results = [];
let failed = false;

async function run(selection) {
  const trace = resolve(directory, `${selection.group}.ndjson`);
  const summaryPath = resolve(directory, `${selection.group}.json`);
  const env = {
    ...process.env,
    SLICC_HEADLESS: '0',
    SLICC_CDP_PORTS: '9300-9309',
    SLICC_GUARD_DIAGNOSTIC_TRACE: trace,
    SLICC_GUARD_DIAGNOSTIC_SUMMARY: summaryPath,
  };
  for (const key of ['GUARD_IDS', 'GUARD_TARGETS', 'GUARD_VARIANTS']) delete env[key];
  if (selection.vectors)
    Object.assign(env, {
      GUARD_IDS: 'C8.iframe-error',
      GUARD_TARGETS: 'network-error',
      GUARD_VARIANTS: 'lagging',
    });
  const remaining = Math.min(18 * 60 * 1000, end - Date.now());
  if (remaining <= 0) return { group: selection.group, status: 'budget', selected: 0, trace: 0 };
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      '--test-timeout=900000',
      '--test-global-setup=test/integration/global.mjs',
      '--test-reporter=./test/integration/guard-native-diagnostic-reporter.mjs',
      `--test-name-pattern=${selection.pattern}`,
      `test/integration/${selection.file}`,
    ],
    { env, stdio: ['ignore', 'ignore', 'ignore'] }
  );
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill('SIGTERM');
  }, remaining);
  const force = setTimeout(() => {
    if (expired) child.kill('SIGKILL');
  }, remaining + 30000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearTimeout(timer);
  clearTimeout(force);
  let summary = { selected: 0, passed: 0, failed: 0, skipped: 0 };
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch {}
  let records = [];
  try {
    records = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => sanitize(JSON.parse(line)))
      .filter(Boolean);
  } catch {}
  writeFileSync(trace, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const instances = records.filter((record) => record.point === 'instance').length;
  const starts = records.filter((record) => record.point === 'cleanup-start').length;
  const verified = records.filter((record) => record.point === 'cleanup-verified').length;
  const result = {
    group: selection.group,
    status: expired
      ? 'deadline'
      : code === 0 &&
          summary.selected > 0 &&
          summary.failed === 0 &&
          summary.skipped === 0 &&
          instances > 0
        ? 'pass'
        : 'fail',
    ...summary,
    trace: records.length,
    instances,
    cleanupStarts: starts,
    cleanupVerified: verified,
  };
  writeFileSync(summaryPath, `${JSON.stringify(result)}\n`);
  return result;
}

try {
  for (const selection of selections) {
    const result = await run(selection);
    results.push(result);
    failed ||= result.status !== 'pass';
  }
} finally {
  restore();
  rmSync('artifacts', { recursive: true, force: true });
  rmSync('junit', { recursive: true, force: true });
  writeFileSync(
    resolve(directory, 'summary.json'),
    `${JSON.stringify({ complete: results.length === selections.length, results })}\n`
  );
}
if (failed || results.length !== selections.length) process.exitCode = 1;
