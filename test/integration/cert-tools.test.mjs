import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

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
