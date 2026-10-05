import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('reaches npm over HTTPS with curl and the everyday tools', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(
    page,
    "curl -sS https://registry.npmjs.org/@ai-ecoverse/wasm-bash/5.3.0-7 | jq -r '.name | ascii_upcase'"
  );
  await shows(page, '@AI-ECOVERSE/WASM-BASH');
  await run(
    page,
    'echo \'{"tool":"jq"}\' | jq -r .tool | grep -c jq | awk \'{ print "found " $1 }\''
  );
  await shows(page, 'found 1');
  await run(page, 'find /usr/bin -name "less" | head -1');
  await shows(page, '/usr/bin/less');
  assert.deepEqual(page.errors, []);
});

test('waits for an updated service worker before opening the shell', async (t) => {
  const page = await chrome.page(t);
  const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
  chrome.overrides.set('/sw.js', current.replace('...isolation, ', ''));
  await page.goto('/');
  await page.until(() => location.pathname === '/os/');
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  chrome.overrides.delete('/sw.js');

  await boot(page);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  await run(page, 'echo "upgraded $((1 + 1))"');
  await shows(page, 'upgraded 2');
});
