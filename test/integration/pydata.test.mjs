import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { actPackage, boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000, persistent: true });
after(() => chrome.close());

const PLOT = 5 * 60 * 1000;
const HAND = 10 * 60 * 1000;
const EARLIER = '@ai-ecoverse/wasix-python@3.14.2-20';
const REMOVE = 5 * 60 * 1000;
const PTH = 'opt/slicc/python/slicc-pydata.pth';
const RECEIPT = 'var/lib/slicc/optional/pydata/package.json';

const SCRIPT = [
  'import numpy as np',
  'import pandas as pd',
  'import matplotlib',
  '',
  "matplotlib.use('Agg')",
  'import matplotlib.pyplot as plt',
  '',
  'a = np.arange(12).reshape(3, 4)',
  "print('numpy', np.__version__, int((a @ a.T).trace()), np.__file__.startswith('/opt/slicc/pydata/'))",
  "df = pd.DataFrame({'k': ['a', 'b', 'a', 'b'], 'v': [1, 2, 3, 4]})",
  "print('pandas', pd.__version__, df.groupby('k')['v'].sum().to_dict())",
  'fig, ax = plt.subplots()',
  'ax.plot([1, 4, 9])',
  "fig.savefig('/home/plot.png')",
  "with open('/home/plot.png', 'rb') as f:",
  "    print('matplotlib', matplotlib.__version__, f.read(8) == b'\\x89PNG\\r\\n\\x1a\\n')",
  'singular = np.array([[1.0, 2.0], [2.0, 4.0]])',
  'for name, call in [',
  "    ('solve', lambda: np.linalg.solve(singular, np.array([1.0, 2.0]))),",
  "    ('inv', lambda: np.linalg.inv(singular)),",
  "    ('cholesky', lambda: np.linalg.cholesky(np.array([[1.0, 2.0], [2.0, 1.0]]))),",
  ']:',
  '    try:',
  "        print(name, 'returned', call().tolist())",
  '    except np.linalg.LinAlgError:',
  "        print(name, 'raised LinAlgError')",
  '',
].join('\n');

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

const exists = (page, path) =>
  page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      await dir.getFileHandle(name).catch(() => dir.getDirectoryHandle(name));
      return true;
    } catch {
      return false;
    }
  }, path);

const file = (page, path, data) =>
  page.evaluate(
    async ([path, data]) => {
      let dir = await navigator.storage.getDirectory();
      const names = path.split('/');
      const name = names.pop();
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      const handle = await dir.getFileHandle(name);
      if (data === null) return (await handle.getFile()).text();
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return data;
    },
    [path, data]
  );

const color = (page, value) =>
  page.evaluate((value) => {
    const app = document.querySelector('slicc-app');
    if (app.color !== value) app.toggleColor();
  }, value);

async function showRow(page) {
  await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
  await page.until(
    () =>
      !!document
        .querySelector('slicc-app')
        .dock.content('updates')
        ?.shadowRoot?.querySelector('li[data-id="pydata"]')
  );
  await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      .shadowRoot.querySelector('li[data-id="python"]')
      .scrollIntoView({ block: 'start' })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function shots(page, name) {
  await color(page, 'light');
  await showRow(page);
  await page.screenshot(new URL(`${name}-light.png`, page.dir));
  await color(page, 'dark');
  await page.screenshot(new URL(`${name}-dark.png`, page.dir));
  await color(page, 'light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await showRow(page);
  await page.screenshot(new URL(`${name}-420.png`, page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
}

describe('Python data tools are back as attested builds: they install as one project next to the catalog’s Python, compute, and remove cleanly', () => {
  let page;
  let finish;
  after(() => finish?.());
  before(async () => {
    page = await chrome.page({
      name: 'Python data tools',
      filePath: import.meta.filename,
      after: (fn) => {
        finish = fn;
      },
    });
    await boot(page);
  });

  test('the catalog offers them, next to a Python from before them, which shows as outdated', async () => {
    await page.until(() =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'pydata')
    );
    const listed = await row(page, 'pydata');
    assert.equal(listed.state, 'available');
    assert.deepEqual(listed.actions, ['install']);
    assert.equal(listed.label, 'Python data tools');
    assert.match(listed.description, /^numpy, pandas and matplotlib for Python/);
    assert.deepEqual(listed.requires, ['python']);
    await run(page, `clear; pnpm add -g ${EARLIER} >/dev/null 2>&1; echo "by hand $((40 + $?))"`);
    await shows(page, 'by hand 4', HAND);
    assert.match(await screen(page), /by hand 40/);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.until(
      () =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .find((item) => item.id === 'python').state === 'outdated'
    );
    await shots(page, 'pydata-before');
  });

  test('installing them updates that Python first, then installs one project with a single numpy and no Python of its own, readable by every user', async () => {
    const result = await actPackage(page, 'pydata', 'install', {
      budget: 14 * 60 * 1000,
      stall: 8 * 60 * 1000,
    });
    const quota = await page.evaluate(() => navigator.storage.estimate());
    assert.equal(
      result,
      'ok',
      `${(await row(page, 'pydata')).log}\nquota ${JSON.stringify(quota)}`
    );
    const python = await row(page, 'python');
    assert.equal(python.state, 'installed');
    assert.equal(python.version, python.offered);
    const installed = await row(page, 'pydata');
    assert.equal(installed.state, 'installed');
    assert.equal(installed.version, installed.offered);
    assert.equal(installed.warnings, undefined);
    assert.ok(await exists(page, PTH));
    assert.ok(await exists(page, 'opt/slicc/python/sitecustomize.py'));
    await run(
      page,
      `clear; echo "unreadable $(find /opt/slicc ! -perm -o=r | wc -l) $(find /opt/slicc -type d ! -perm -o=x | wc -l)"; echo "numpy [$(find /opt/slicc/pydata -path '*/py-numpy/package.json' | xargs jq -r .version | sort -u | tr '\\n' ' ')]"; echo "python [$(find /opt/slicc/pydata -name 'wasix-python*' | wc -l)]"; echo "pythons [$(cat "$PNPM_HOME"/global/v11/*/node_modules/@ai-ecoverse/wasix-python/package.json | jq -r .version | sort -u | tr '\\n' ' ')]"; echo "checked $((6 * 7))"`
    );
    await shows(page, 'checked 42');
    const text = await screen(page);
    assert.match(text, /unreadable 0 0/);
    assert.match(text, /numpy \[2\.3\.2-\d+ \]/);
    assert.match(text, /python \[0\]/);
    assert.ok(text.includes(`pythons [${python.offered} ]`), text);
    await shots(page, 'pydata-after');
  });

  test('numpy, pandas and matplotlib compute (an array op, a groupby and a PNG plot), and numpy.linalg raises LinAlgError on a singular matrix (homescoop#1082)', async () => {
    await run(
      page,
      `clear; cd /home && echo ${Buffer.from(SCRIPT).toString('base64')} | base64 -d > /home/pydata.py && python3 /home/pydata.py; echo "pydata exit $((40 + $?))"`
    );
    await shows(page, 'pydata exit 4', PLOT);
    const text = await screen(page);
    assert.match(text, /pydata exit 40/, text);
    assert.match(text, /numpy 2\.3\.2 506 True/);
    assert.match(text, /pandas 2\.3\.2 \{'a': 4, 'b': 6\}/);
    assert.match(text, /matplotlib 3\.11\.2 True/);
    for (const name of ['solve', 'inv', 'cholesky'])
      assert.match(text, new RegExp(`${name} raised LinAlgError`), text);
    assert.doesNotMatch(text, /returned/);
    await color(page, 'light');
    await page.screenshot(new URL('pydata-terminal-light.png', page.dir));
  });

  test('an install from before the withdrawal (2026.10.12) shows as outdated, with Update', async () => {
    const receipt = await file(page, RECEIPT, null);
    const current = JSON.parse(receipt).version;
    await file(page, RECEIPT, receipt.replace(`"version":"${current}"`, '"version":"2026.10.12"'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.until(
      () =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .find((item) => item.id === 'pydata').state === 'outdated'
    );
    const outdated = await row(page, 'pydata');
    assert.equal(outdated.version, '2026.10.12');
    assert.deepEqual(outdated.actions, ['update', 'remove']);
    await file(page, RECEIPT, receipt);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.until(
      () =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .find((item) => item.id === 'pydata').state === 'installed'
    );
  });

  test('without Python they warn, and they remove cleanly', async () => {
    await page.evaluate(() => {
      window.removed = undefined;
      document
        .querySelector('slicc-app')
        .model.updates.actPackage('python', 'remove')
        .then(
          () => 'ok',
          (error) => error.message
        )
        .then((result) => {
          window.removed = result;
        });
    });
    await page.until(
      () => !!document.querySelector('slicc-app').shadowRoot.querySelector('slicc-confirm')
    );
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .shadowRoot.querySelector('slicc-confirm')
        .renderRoot.querySelector('[data-action]')
        .click()
    );
    assert.equal(await page.within(REMOVE, () => window.removed), 'ok');
    assert.equal((await row(page, 'python')).state, 'available');
    const orphan = await row(page, 'pydata');
    assert.equal(orphan.state, 'installed');
    assert.deepEqual(orphan.warnings, [
      "Needs Python, which isn't installed. Install Python again to use it.",
    ]);
    await shots(page, 'pydata-without-python');

    assert.equal(await actPackage(page, 'pydata', 'remove'), 'ok');
    assert.equal((await row(page, 'pydata')).state, 'available');
    assert.equal(await exists(page, PTH), false);
    assert.equal(await exists(page, 'opt/slicc/pydata'), false);
    assert.equal(await exists(page, RECEIPT), false);
    assert.deepEqual(page.errors, []);
  });
});
