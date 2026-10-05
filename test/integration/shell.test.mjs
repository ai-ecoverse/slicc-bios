import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, opfs, ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test('boots into bash -i in the terminal and keeps what it writes in OPFS', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);

  await run(page, 'echo "sum $((6 * 7))"');
  await shows(page, 'sum 42');

  await run(page, 'seq 3 | tac | tr "\\n" " " > booted.txt; cat booted.txt; echo; pwd');
  await shows(page, '3 2 1');
  await shows(page, '/home');
  assert.equal(await read(page, 'home/booted.txt'), '3 2 1 ');
  await page.screenshot(new URL('shell.png', page.dir));

  await page.reload();
  await ready(page);
  assert.ok((await opfs(page)).includes('home/booted.txt'));
  assert.equal(await read(page, 'home/booted.txt'), '3 2 1 ');

  await run(page, 'echo "words $(wc -w < booted.txt)"');
  await shows(page, 'words 3');
  assert.deepEqual(page.errors, []);
});
