import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { actPackage, boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000, persistent: true });
after(() => chrome.close());

const INSTALL = { budget: 14 * 60 * 1000, stall: 8 * 60 * 1000 };
const PROBE = 5 * 60 * 1000;
const PYTHON = '@ai-ecoverse/wasix-python';
const OLD = '3.14.2-28';
const PACKAGES = [
  'py-python-dateutil',
  'py-tzdata',
  'py-six',
  'py-numpy',
  'py-pandas',
  'py-pillow',
  'py-scipy',
];
const repo = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, repo), 'utf8');

async function shipped() {
  const python = JSON.parse(await read('src/packages/optional/package.json')).dependencies[PYTHON];
  const project = JSON.parse(await read('src/packages/optional/projects/pydata/package.json'));
  const lock = await read('src/packages/optional/projects/pydata/pnpm-lock.yaml');
  const block = lock.slice(lock.indexOf('\npackages:\n'), lock.indexOf('\nsnapshots:\n'));
  const locked = Object.fromEntries(
    [...block.matchAll(/^ {2}'@ai-ecoverse\/([^@']+)@([^']+)':$/gm)].map(([, name, at]) => [
      name,
      at,
    ])
  );
  return { python, version: project.version, locked };
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    `clear; python3 -c "${script}"; echo "builds [$(find /opt/slicc/pydata -name '*.cpython-314*.so' | wc -l) $(find /opt/slicc/pydata -name '*.cpython-315*.so' | wc -l)]"; echo "pth [$(tr '\\n' ' ' < /opt/slicc/python/slicc-pydata.pth)]"; echo "${mark} $((6 * 7))"`
  );
  await shows(page, `${mark} 42`, PROBE);
  return (await screen(page)).replace(/\s+/g, ' ');
}

describe('a profile with the Python 3.14 data tools updates to 3.15 with Update: Python first, then the project, with nothing of 3.14 left', () => {
  let page;
  let finish;
  let files;
  let now;
  after(() => finish?.());
  before(async () => {
    page = await chrome.page({
      name: 'Python 3.14 to 3.15',
      filePath: import.meta.filename,
      after: (fn) => {
        finish = fn;
      },
    });
  });

  test('a profile installs the Python 3.14 data tools from the 3.14 catalog', async () => {
    files = await earlier();
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
    assert.match(before, /builds \[[1-9]\d* 0\]/);
  });

  test('on the 3.15 catalog Python and the data tools show as outdated, and Update moves Python first, then the project', async () => {
    for (const path of Object.keys(files)) chrome.overrides.delete(path);
    await page.reload();
    await ready(page);
    await page.until(() => {
      const rows = document.querySelector('slicc-app').model.updates.packages();
      const state = (id) => rows.find((item) => item.id === id)?.state;
      return state('python') === 'outdated' && state('pydata') === 'outdated';
    });
    const offered = await row(page, 'pydata');
    assert.deepEqual(offered.actions, ['update', 'remove']);
    now = await shipped();
    assert.equal(offered.offered, now.version);
    assert.equal(await actPackage(page, 'pydata', 'update', INSTALL), 'ok');
    const python = await row(page, 'python');
    const tools = await row(page, 'pydata');
    assert.deepEqual(
      [python.state, python.version, tools.state, tools.version],
      ['installed', now.python, 'installed', now.version]
    );
  });

  test('nothing of 3.14 is left: no cp314 file, no python3.14 path, no old version, pytz gone, and one copy of every package', async () => {
    const later = await probe(page, 'after');
    assert.match(later, /runs 3\.15 2\.5\.4 3\.0\.6 True/);
    assert.match(later, /builds \[0 [1-9]\d*\]/);
    assert.match(later, /pth \[[^\]]*python3\.15\/site-packages/);
    assert.doesNotMatch(later, /python3\.14/);
    await run(
      page,
      `clear; echo "left [$(find /opt/slicc/pydata /opt/slicc/python -name '*cpython-314*' | wc -l)] [$(find /opt/slicc/pydata /opt/slicc/python -path '*python3.14*' | wc -l)]"; echo "pytz [$(find /opt/slicc/pydata -path '*py-pytz*' | wc -l)]"; for p in ${PACKAGES.join(' ')}; do echo "$p [$(find /opt/slicc/pydata -path "*/@ai-ecoverse/$p/package.json" | xargs jq -r .version | sort -u | tr '\\n' ' ')] locked $(grep -o "^  '@ai-ecoverse/$p@[^']*'" /opt/slicc/pydata/pnpm-lock.yaml | sort -u | wc -l)"; done; echo "pythons [$(cat "$PNPM_HOME"/global/v11/*/node_modules/${PYTHON}/package.json | jq -r .version | sort -u | tr '\\n' ' ')]"; echo "checked $((6 * 7))"`
    );
    await shows(page, 'checked 42', PROBE);
    const left = (await screen(page)).replace(/\s+/g, ' ');
    assert.match(left, /left \[0\] \[0\]/);
    assert.match(left, /pytz \[0\]/);
    for (const name of PACKAGES)
      assert.match(left, new RegExp(`${name} \\[${escaped(now.locked[name])} \\] locked 1`), name);
    assert.match(left, new RegExp(`pythons \\[${escaped(now.python)} \\]`));
    assert.deepEqual(page.errors, []);
  });
});
