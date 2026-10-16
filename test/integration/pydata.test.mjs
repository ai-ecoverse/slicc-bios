import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const RECEIPT = 'var/lib/slicc/optional/pydata/package.json';
const PTH = 'opt/slicc/python/slicc-pydata.pth';
const PROJECT = 'opt/slicc/pydata/node_modules/@ai-ecoverse/py-pandas/package.json';

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id) ?? null,
    id
  );

const exists = (page, path) =>
  page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }, path);

test('Python data tools are withdrawn until numpy and pandas come from verified CI builds (homescoop#826, #730): the catalog offers Python but not them, and an earlier install shows as retired and removes cleanly', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'python')
  );
  assert.equal(await row(page, 'pydata'), null);

  await page.evaluate(
    async ({ files }) => {
      const root = await navigator.storage.getDirectory();
      for (const [path, data] of Object.entries(files)) {
        const names = path.split('/');
        const name = names.pop();
        let dir = root;
        for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(data);
        await writable.close();
      }
    },
    {
      files: {
        [RECEIPT]: `${JSON.stringify({ name: 'slicc-py-datatools', version: '2026.10.12', pth: PTH })}\n`,
        [PTH]: '/opt/slicc/pydata/node_modules/@ai-ecoverse/py-pandas/site\n',
        [PROJECT]: '{"name":"@ai-ecoverse/py-pandas","version":"2.3.2-10"}\n',
      },
    }
  );
  await page.reload();
  await ready(page);
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === 'pydata')?.state === 'installed'
  );
  const retired = await row(page, 'pydata');
  assert.equal(retired.label, 'Python data tools');
  assert.equal(retired.version, '2026.10.12');
  assert.deepEqual(retired.actions, ['remove']);
  assert.match(retired.description, /No longer offered/);

  const removed = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.actPackage('pydata', 'remove')
      .then(
        () => 'ok',
        (error) => error.message
      )
  );
  assert.equal(removed, 'ok');
  assert.equal(await row(page, 'pydata'), null);
  for (const path of [RECEIPT, PTH, PROJECT]) assert.equal(await exists(page, path), false, path);
  assert.deepEqual(page.errors, []);
});
