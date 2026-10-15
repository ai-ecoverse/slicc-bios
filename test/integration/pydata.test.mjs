import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000, persistent: true });
after(() => chrome.close());

const INSTALL = 15 * 60 * 1000;
const PTH = 'opt/slicc/python/slicc-pydata.pth';

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

async function act(page, id, action) {
  await page.evaluate(
    ([id, action]) => {
      window.acted = undefined;
      document
        .querySelector('slicc-app')
        .model.updates.actPackage(id, action)
        .then(
          () => 'ok',
          (error) => error.message
        )
        .then((result) => {
          window.acted = result;
        });
    },
    [id, action]
  );
  await page.within(INSTALL, () => window.acted !== undefined);
  return page.evaluate(() => window.acted);
}

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

describe('Python data tools install as one project next to the catalog’s Python, import, plot, and remove cleanly', () => {
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

  test('they install as one project next to the catalog’s Python, readable by every user', async () => {
    await page.until(() =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'pydata')
    );
    const listed = await row(page, 'pydata');
    assert.equal(listed.state, 'available');
    assert.deepEqual(listed.requires, ['python']);
    await shots(page, 'pydata-before');

    const result = await act(page, 'pydata', 'install');
    const quota = await page.evaluate(() => navigator.storage.estimate());
    assert.equal(
      result,
      'ok',
      `${(await row(page, 'pydata')).log}\nquota ${JSON.stringify(quota)}`
    );
    assert.equal((await row(page, 'python')).state, 'installed');
    const installed = await row(page, 'pydata');
    assert.equal(installed.state, 'installed');
    assert.equal(installed.warnings, undefined);
    assert.ok(await exists(page, PTH));
    assert.ok(await exists(page, 'opt/slicc/python/sitecustomize.py'));
    await run(
      page,
      'clear; echo "unreadable $(find /opt/slicc ! -perm -o=r | wc -l) $(find /opt/slicc -type d ! -perm -o=x | wc -l)"; echo "checked $((6 * 7))"'
    );
    await shows(page, 'checked 42');
    assert.match(await screen(page), /unreadable 0 0/);
    await shots(page, 'pydata-after');
  });

  test('numpy, pandas, scipy and matplotlib import and plot', async () => {
    await run(
      page,
      `clear; cd /home && python3 -c "import numpy, pandas, scipy, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.plot([1, 4, 9]); plt.savefig('/home/plot.png'); print('numpy', numpy.__version__, 'pandas', pandas.__version__, 'scipy', scipy.__version__, 'matplotlib', matplotlib.__version__)" && ls -l /home/plot.png && echo "plotted $((6 * 7))"`
    );
    await page.within(INSTALL, () =>
      window.document
        .querySelector('slicc-app')
        .dock.content(
          window.document
            .querySelector('slicc-app')
            .dock.api.panels.map((panel) => panel.id)
            .findLast((id) => id.startsWith('terminal:'))
        )
        .screen.textContent.includes('plotted 42')
    );
    assert.match(
      await screen(page),
      /numpy 2\.3\.2 pandas 2\.3\.2 scipy 1\.18\.0 matplotlib 3\.11\.2/
    );
    await color(page, 'light');
    await page.screenshot(new URL('pydata-terminal-light.png', page.dir));
  });

  test('without Python they warn, and they remove cleanly', async () => {
    await page.evaluate(() => {
      window.removed = document
        .querySelector('slicc-app')
        .model.updates.actPackage('python', 'remove');
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
    await page.evaluate(() => window.removed);
    assert.equal((await row(page, 'python')).state, 'available');
    const orphan = await row(page, 'pydata');
    assert.equal(orphan.state, 'installed');
    assert.deepEqual(orphan.warnings, [
      "Needs Python, which isn't installed. Install Python again to use it.",
    ]);
    await shots(page, 'pydata-without-python');

    assert.equal(await act(page, 'pydata', 'remove'), 'ok');
    assert.equal((await row(page, 'pydata')).state, 'available');
    assert.equal(await exists(page, PTH), false);
    assert.equal(await exists(page, 'opt/slicc/pydata'), false);
    await shows(page, 'plotted 42');
    assert.deepEqual(page.errors, []);
  });
});
