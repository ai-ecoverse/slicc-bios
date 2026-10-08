import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, opfs, ready, run, shows, ui } from './bios.mjs';
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
  await run(page, 'which bash; which nope 2>/dev/null; echo "which says $?"');
  await shows(page, '/usr/bin/bash');
  await shows(page, 'which says 1');
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

test('boots into the SLICC UI: a file from the terminal shows up in the tree, opens and edits in a tab, and stays', async (t) => {
  const page = await chrome.page(t);
  await ui(page);
  await boot(page);
  assert.deepEqual(
    await page.evaluate(() =>
      window.ui
        .app()
        .dock.api.panels.map((panel) => panel.id)
        .sort()
    ),
    ['files', 'terminal']
  );
  assert.equal(await page.evaluate(() => window.ui.app().dock.api.activePanel?.id), 'terminal');

  await run(
    page,
    'mkdir -p notes && echo "first $((2 * 21))" > notes/today.md; cat notes/today.md'
  );
  await shows(page, 'first 42');
  await page.until(() => window.ui.tree().paths.includes('home/notes/today.md'));
  await page.evaluate(() => {
    const { tree } = window.ui.tree();
    tree.getItem('home/').expand();
    tree.getItem('home/notes/').expand();
    tree.getItem('home/notes/today.md').select();
  });
  const path = '/home/notes/today.md';
  const shown = (text) =>
    page.until(([path, text]) => window.ui.code(path).includes(text), [path, text]);
  await shown('first 42');

  await page.evaluate((path) => window.ui.button(path, 'Edit').click(), path);
  await page.until((path) => !!window.ui.view(path).shadowRoot.querySelector('textarea'), path);
  await page.evaluate((path) => {
    const area = window.ui.view(path).shadowRoot.querySelector('textarea');
    area.value = '# edited in SLICC\n';
    area.dispatchEvent(new Event('input'));
    area.focus();
  }, path);
  await page.press('s', 'ctrl');
  await shown('# edited in SLICC');
  await run(page, 'cat notes/today.md');
  await shows(page, '# edited in SLICC');
  await run(page, 'echo "and from bash" >> notes/today.md');
  await shown('and from bash');
  await page.screenshot(new URL('ui.png', page.dir));

  await page.reload();
  await ready(page);
  await shown('and from bash');
  await run(page, 'echo "lines $(wc -l < notes/today.md)"');
  await shows(page, 'lines 2');
  assert.deepEqual(page.errors, []);
});
test('lists and kills processes with procps', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(page, 'sleep 60 & ps | grep -c "[s]leep" | sed "s/^/sleeping /"');
  await shows(page, 'sleeping 1');
  await run(
    page,
    'env kill $(pgrep sleep); sleep 1; ps | grep -c "[s]leep" | sed "s/^/after kill /"'
  );
  await shows(page, 'after kill 0');
  await run(page, 'free | head -1 | grep -c total | sed "s/^/free /"');
  await shows(page, 'free 1');
  assert.deepEqual(page.errors, []);
});
