import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run, screen, settled, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const KERNEL = 'node_modules/@ai-ecoverse/slicc-kernel/package.json';
const SHIM = '/node_modules/@ai-ecoverse/wasi-pnpm/shims/i';

test('the BIOS installer keeps each packed file’s mode, so a shim outside bin/ stays executable', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const kernel = await page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  }, KERNEL);
  if (!kernel.exports?.['./meta']) {
    t.skip(`slicc-kernel ${kernel.version} has no /meta`);
    return;
  }
  await settled(page);
  await run(
    page,
    `clear; stat -c '%a %u:%g %n' ${SHIM} /node_modules/@ai-ecoverse/wasi-pnpm/package.json /os/os.js; ${SHIM} --help > /dev/null 2>&1; echo shim=$?; echo modes-$((40 + 2))`
  );
  await shows(page, 'modes-42');
  const text = await screen(page);
  assert.match(text, /755 0:0 \/node_modules\/@ai-ecoverse\/wasi-pnpm\/shims\/i/);
  assert.match(text, /644 0:0 \/node_modules\/@ai-ecoverse\/wasi-pnpm\/package\.json/);
  assert.match(text, /644 0:0 \/os\/os\.js/);
  assert.match(text, /shim=0/);
  assert.deepEqual(page.errors, []);
});

test('a profile from a kernel without /meta gets its modes on the first boot with one', async (t) => {
  const { readFileSync } = await import('node:fs');
  const shipped = JSON.parse(
    readFileSync(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8')
  );
  const page = await chrome.page(t);
  const older = structuredClone(shipped);
  older.packages['node_modules/@ai-ecoverse/slicc-kernel'] = {
    version: '1.81.0',
    resolved: 'https://registry.npmjs.org/@ai-ecoverse/slicc-kernel/-/slicc-kernel-1.81.0.tgz',
    integrity:
      'sha512-hc1KHvrTaSS7nHS2D+0yX0oTs5Tx5gs0yQJOExK0nWSqjO8Dkefp5P013ucYkTeBXR3o9M3xVyayCU/4LbySjQ==',
  };
  chrome.overrides.set('/packages/package-lock.json', JSON.stringify(older));
  await boot(page);
  const kernel = async () =>
    page.evaluate(async (path) => {
      let dir = await navigator.storage.getDirectory();
      const names = path.split('/');
      const name = names.pop();
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
    }, KERNEL);
  chrome.overrides.delete('/packages/package-lock.json');
  await page.goto('/');
  await ready(page);
  if (!(await kernel()).exports?.['./meta']) {
    t.skip(`slicc-kernel ${(await kernel()).version} has no /meta`);
    return;
  }
  await run(
    page,
    `clear; stat -c '%a %n' ${SHIM} /node_modules/@ai-ecoverse/wasi-pnpm/shims/npm /node_modules/@ai-ecoverse/wasi-pnpm/shims/npx; ${SHIM} --help > /dev/null 2>&1; echo i=$?; echo again-$((40 + 2))`
  );
  await shows(page, 'again-42');
  const text = await screen(page);
  assert.match(text, /755 \/node_modules\/@ai-ecoverse\/wasi-pnpm\/shims\/i/);
  assert.match(text, /755 \/node_modules\/@ai-ecoverse\/wasi-pnpm\/shims\/npm/);
  assert.match(text, /755 \/node_modules\/@ai-ecoverse\/wasi-pnpm\/shims\/npx/);
  assert.match(text, /i=0/);
  assert.deepEqual(page.errors, []);
});
