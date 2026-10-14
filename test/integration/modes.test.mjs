import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
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
