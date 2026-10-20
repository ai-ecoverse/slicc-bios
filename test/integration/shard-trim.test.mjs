import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLASSES, UNCLASSIFIED } from '../../scripts/cert/evidence.mjs';
import { clean, slug, trim } from '../../scripts/ci/shard.mjs';

const FILE = `test/integration/${UNCLASSIFIED[0]}.test.mjs`;
const pass = (name, path = [name]) => ({ file: FILE, name, path, status: 'pass' });
const fail = (name, path = [name]) => ({ file: FILE, name, path, status: 'fail' });

async function artifacts(tests) {
  const root = await mkdtemp(join(tmpdir(), 'trim-'));
  for (const name of tests) {
    const dir = join(root, slug(UNCLASSIFIED[0]), slug(name));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'stall-1-trace.json'), 'x'.repeat(1000));
    await writeFile(join(dir, 'agent-install-trace.json'), 'install');
    await writeFile(join(dir, 'tab-1.png'), 'png');
    await writeFile(join(dir, 'console.log'), 'log');
  }
  return root;
}

test("a shard drops the stall traces of tests that passed in every attempt, lists each with its size, and keeps screenshots, logs and every failed or flaky test's files", async (t) => {
  const names = ['installs zip', 'a failed download retries', 'shows the catalog', 'flips once'];
  const root = await artifacts(names);
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = {
    files: [FILE],
    code: 1,
    results: [
      pass('installs zip'),
      pass('a failed download retries'),
      fail('the retry row', ['a failed download retries', 'the retry row']),
      pass('shows the catalog'),
      fail('flips once'),
    ],
  };
  const retried = { files: [FILE], code: 0, results: [pass('flips once')] };
  const tests = clean([first, retried]);
  assert.deepEqual(
    tests.map(({ name }) => name),
    ['installs zip', 'shows the catalog']
  );
  const dropped = await trim(tests, root);
  assert.deepEqual(dropped, [
    { path: `${slug(UNCLASSIFIED[0])}/installs-zip/stall-1-trace.json`, bytes: 1000 },
    { path: `${slug(UNCLASSIFIED[0])}/shows-the-catalog/stall-1-trace.json`, bytes: 1000 },
  ]);
  assert.deepEqual((await readdir(join(root, slug(UNCLASSIFIED[0]), 'installs-zip'))).sort(), [
    'agent-install-trace.json',
    'console.log',
    'tab-1.png',
  ]);
  for (const kept of ['a-failed-download-retries', 'flips-once']) {
    assert.ok(
      (await readdir(join(root, slug(UNCLASSIFIED[0]), kept))).includes('stall-1-trace.json'),
      kept
    );
  }
});

test('a file that crashed without reporting keeps every artifact, and an unknown directory is left alone', async (t) => {
  const root = await artifacts(['installs zip']);
  t.after(() => rm(root, { recursive: true, force: true }));
  const crashed = clean([
    { files: [FILE, 'test/integration/other.test.mjs'], code: 1, results: [pass('installs zip')] },
  ]);
  assert.deepEqual(crashed, [{ file: FILE, name: 'installs zip' }]);
  const whole = clean([{ files: [FILE], code: 1, results: [] }]);
  assert.deepEqual(whole, []);
  assert.deepEqual(await trim([{ file: FILE, name: 'never ran' }], root), []);
  assert.deepEqual(clean([null, { files: [FILE], code: 0, results: [pass('x', [])] }]), [
    { file: FILE, name: 'x' },
  ]);
});

test("every file in cert review's CLASSES keeps every artifact even when every test passed, and so does a file in no list yet", () => {
  const pass = (path) => [
    { files: [path], code: 0, results: [{ file: path, name: 'a', path: ['a'], status: 'pass' }] },
  ];
  const classed = Object.values(CLASSES).flat();
  assert.ok(classed.length > 20);
  for (const name of [...classed, 'a-brand-new-row']) {
    assert.deepEqual(clean(pass(`test/integration/${name}.test.mjs`)), [], name);
  }
  for (const name of UNCLASSIFIED) {
    assert.equal(clean(pass(`test/integration/${name}.test.mjs`)).length, 1, name);
  }
});
