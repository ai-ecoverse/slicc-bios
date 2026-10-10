import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const manifest = JSON.parse(
  await readFile(new URL('../../src/manifest.json', import.meta.url), 'utf8')
);

test('seven is installable as an app from the UI, and stays cross-origin isolated', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.equal(await page.evaluate(() => location.pathname), '/os/');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);

  const app = await page.send('Page.getAppManifest');
  assert.equal(new URL(app.url).pathname, '/manifest.json');
  assert.deepEqual(app.errors, []);
  assert.deepEqual(JSON.parse(app.data), manifest);
  const { installabilityErrors } = await page.send('Page.getInstallabilityErrors');
  assert.deepEqual(
    installabilityErrors.map(({ errorId }) => errorId).filter((id) => id !== 'in-incognito'),
    []
  );

  const icons = await page.evaluate(
    (icons) =>
      Promise.all(
        icons.map(async ({ src }) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          return `${src} ${image.naturalWidth}x${image.naturalHeight}`;
        })
      ),
    manifest.icons
  );
  assert.deepEqual(
    icons,
    manifest.icons.map(({ src, sizes }) => `${src} ${sizes}`)
  );
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('meta[name="theme-color"]')].map(
        (meta) => `${meta.media} ${meta.content}`
      )
    ),
    ['(prefers-color-scheme: light) #f8f8f8', '(prefers-color-scheme: dark) #1b1b1b']
  );
  assert.deepEqual(page.errors, []);
});
