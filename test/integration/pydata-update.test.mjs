import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { actPackage, boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000, persistent: true });
after(() => chrome.close());

const INSTALL = { budget: 14 * 60 * 1000, stall: 8 * 60 * 1000 };
const PROBE = 5 * 60 * 1000;
const PYTHON = '@ai-ecoverse/wasix-python';
const OLD = '3.14.2-28';
const repo = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, repo), 'utf8');

async function earlier() {
  const certs = JSON.parse(await read('src/packages/certs.json'));
  const manifest = JSON.parse(await read('src/packages/optional/package.json'));
  manifest.dependencies[PYTHON] = OLD;
  const lock = JSON.parse(await read('src/packages/optional/package-lock.json'));
  lock.packages[''].dependencies[PYTHON] = OLD;
  Object.assign(lock.packages[`node_modules/${PYTHON}`], {
    version: OLD,
    resolved: `https://registry.npmjs.org/${PYTHON}/-/wasix-python-${OLD}.tgz`,
    integrity: certs[`${PYTHON}@${OLD}`].integrity,
  });
  const files = {
    '/packages/optional/package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    '/packages/optional/package-lock.json': `${JSON.stringify(lock, null, 2)}\n`,
  };
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    files[`/packages/optional/projects/pydata/${name}`] = await read(
      `test/integration/fixtures/pydata-3.14/${name}`
    );
  return files;
}

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

async function probe(page, mark) {
  const script = [
    "import sys, numpy, pandas; print('runs %d.%d' % sys.version_info[:2], numpy.__version__, pandas.__version__, numpy.__file__.startswith('/opt/slicc/pydata/'))",
  ].join('\n');
  await run(
    page,
    `clear; python3 -c "${script}"; echo "pth [$(tr '\\n' ' ' < /opt/slicc/python/slicc-pydata.pth)]"; echo "${mark} $((6 * 7))"`
  );
  await shows(page, `${mark} 42`, PROBE);
  return (await screen(page)).replace(/\s+/g, ' ');
}

test('a profile with the Python 3.14 data tools updates to 3.15 with Update: Python first, then the project, with nothing of 3.14 left, pytz gone and one dateutil and tzdata', async (t) => {
  const page = await chrome.page(t);
  const files = await earlier();
  for (const [path, body] of Object.entries(files)) chrome.overrides.set(path, body);
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'pydata' && item.offered === '2026.10.19')
  );
  assert.equal(await actPackage(page, 'pydata', 'install', INSTALL), 'ok');
  assert.deepEqual(
    [(await row(page, 'python')).version, (await row(page, 'pydata')).version],
    [OLD, '2026.10.19']
  );
  const before = await probe(page, 'before');
  assert.match(before, /runs 3\.14 2\.3\.2 2\.3\.2 True/);
  assert.match(before, /pth \[[^\]]*python3\.14\/site-packages/);

  for (const path of Object.keys(files)) chrome.overrides.delete(path);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.until(() => {
    const rows = document.querySelector('slicc-app').model.updates.packages();
    const state = (id) => rows.find((item) => item.id === id)?.state;
    return state('python') === 'outdated' && state('pydata') === 'outdated';
  });
  const offered = await row(page, 'pydata');
  assert.deepEqual(offered.actions, ['update', 'remove']);
  assert.equal(offered.offered, '2026.10.20');

  assert.equal(await actPackage(page, 'pydata', 'update', INSTALL), 'ok');
  const python = await row(page, 'python');
  const tools = await row(page, 'pydata');
  assert.deepEqual(
    [python.state, python.version, tools.state, tools.version],
    ['installed', '3.15.0-2', 'installed', '2026.10.20']
  );
  const after = await probe(page, 'after');
  assert.match(after, /runs 3\.15 2\.5\.4 3\.0\.6 True/);
  assert.match(after, /pth \[[^\]]*python3\.15\/site-packages/);
  assert.doesNotMatch(after, /python3\.14/);

  await run(
    page,
    `clear; echo "left [$(find /opt/slicc/pydata /opt/slicc/python -path '*python3.14*' | wc -l)]"; echo "pytz [$(find /opt/slicc/pydata -path '*py-pytz*' | wc -l)]"; for p in py-python-dateutil py-tzdata py-numpy; do echo "$p [$(find /opt/slicc/pydata -path "*/@ai-ecoverse/$p/package.json" | xargs jq -r .version | sort -u | tr '\\n' ' ')] locked $(grep -o "^  '@ai-ecoverse/$p@[^']*'" /opt/slicc/pydata/pnpm-lock.yaml | sort -u | wc -l)"; done; echo "pythons [$(cat "$PNPM_HOME"/global/v11/*/node_modules/${PYTHON}/package.json | jq -r .version | sort -u | tr '\\n' ' ')]"; echo "checked $((6 * 7))"`
  );
  await shows(page, 'checked 42', PROBE);
  const left = (await screen(page)).replace(/\s+/g, ' ');
  assert.match(left, /left \[0\]/);
  assert.match(left, /pytz \[0\]/);
  assert.match(left, /py-python-dateutil \[2\.9\.0-post0\.3 \] locked 1/);
  assert.match(left, /py-tzdata \[2026\.4\.0-3 \] locked 1/);
  assert.match(left, /py-numpy \[2\.5\.4-1 \] locked 1/);
  assert.match(left, /pythons \[3\.15\.0-2 \]/);
  assert.deepEqual(page.errors, []);
});
