import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = new Set([
  'test/integration/guard-set-proxy-rest.test.mjs',
  'test/integration/guard-set-link-rest.test.mjs',
  'test/integration/guard-set-proxy-apex-lagging.test.mjs',
  'test/integration/guard-frames.test.mjs',
  'test/integration/cdp.test.mjs',
  'test/integration/sign-in-held.test.mjs',
  'test/integration/guard-redirect.test.mjs',
]);
const file = process.env.SLICC_GUARD_DIAGNOSTIC_FILE;
if (!files.has(file)) throw new Error('unknown diagnostic file');
const directory = join(process.cwd(), 'guard-diagnostics');
const privateDirectory = join(process.env.RUNNER_TEMP ?? '/tmp', 'guard-diagnostic-private');
mkdirSync(directory, { recursive: true });
mkdirSync(privateDirectory, { recursive: true });
const output = join(privateDirectory, 'test-output.log');
const fd = openSync(output, 'w', 0o600);
const args = [
  '--test',
  '--test-concurrency=1',
  '--test-timeout=900000',
  '--test-global-setup=test/integration/global.mjs',
  '--test-reporter=spec',
  `--test-name-pattern=${process.env.SLICC_GUARD_DIAGNOSTIC_PATTERN}`,
  file,
];
const child = spawn(process.execPath, args, {
  env: {
    ...process.env,
    SLICC_GUARD_DIAGNOSTIC_DIR: directory,
    SLICC_INSTALL_TRACE: '0',
    SLICC_COVERAGE: '0',
    SLICC_PROFILE: '0',
    NODE_OPTIONS: '',
  },
  stdio: ['ignore', fd, fd],
});
const result = await new Promise((resolve) => {
  child.on('error', () => resolve({ code: 1, signal: null }));
  child.on('exit', (code, signal) => resolve({ code, signal }));
});
closeSync(fd);
const text = readFileSync(output, 'utf8');
rmSync(output, { force: true });
const count = (label) => Number(text.match(new RegExp(`(?:ℹ|#) ${label}[: ]+(\\d+)`))?.[1] ?? 0);
const summary = {
  base: '1f2d42eb5264a3a8712f38cff1d5a8f5abdc3eb6',
  file,
  attempts: 1,
  code: result.code,
  interrupted: Boolean(result.signal),
  tests: count('tests'),
  pass: count('pass'),
  fail: count('fail'),
  cancelled: count('cancelled'),
  skipped: count('skipped'),
};
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
process.exitCode = result.code === 0 && !result.signal ? 0 : 1;
