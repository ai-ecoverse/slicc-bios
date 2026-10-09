import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, opfs, ready, run, screen, shows, ui } from './bios.mjs';
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
  await run(page, 'seq 3 | xargs -n 1 echo | wc -l | sed "s/^/xargs ran /"');
  await shows(page, 'xargs ran 3');
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
        .dock.api.panels.map((panel) => panel.id.replace(/^terminal:.*/, 'terminal'))
        .sort()
    ),
    ['agents', 'files', 'terminal']
  );
  assert.match(await page.evaluate(() => window.ui.app().dock.api.activePanel?.id), /^terminal:/);
  assert.deepEqual(
    await page.evaluate(() => [
      window.ui.app().surfaces.some((surface) => surface.id === 'updates'),
      !!window.ui.app().model.updates,
    ]),
    [false, false]
  );

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

test('keeps the pid across exec and agrees with ps, and pkill -f spares itself', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(
    page,
    'bash -c \'echo $$ $PPID; ps -o pid=,ppid= -p $$\' | tr -s " " | sed "s/^ //" | uniq -c | awk -v outer=$$ \'{ print "ps agrees " ($1 == 2 && $3 == outer) * 42 }\''
  );
  await shows(page, 'ps agrees 42');
  await run(
    page,
    'bash -c \'echo $$; exec bash -c "echo \\$\\$; ps -o pid= -p \\$\\$"\' | tr -d " " | uniq -c | awk \'{ print "exec kept " $1 }\''
  );
  await shows(page, 'exec kept 3');
  await run(
    page,
    'sleep 30 & sleep 1; pkill -f "sleep 30"; echo "pkill $((1000 + $?))"; sleep 1; pgrep -f "sleep 30" | wc -l | sed "s/^/left /"'
  );
  await shows(page, 'pkill 1000');
  await shows(page, 'left 0');
  assert.deepEqual(page.errors, []);
});

test('installs a command with pnpm add -g and runs it in the same shell', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(page, 'pnpm add -g @ai-ecoverse/wasm-xxd@9.1.1850; echo "added $((40+$?))"');
  await shows(page, 'added 4', 300000);
  assert.match(await screen(page), /added 40/, await screen(page));
  await run(page, 'echo hi | xxd');
  await shows(page, '00000000: 6869 0a');
  await run(
    page,
    'pnpm remove -g @ai-ecoverse/wasm-xxd; xxd -v >/dev/null 2>&1; echo "gone $((1000+$?))"'
  );
  await shows(page, 'gone 1', 300000);
  assert.match(await screen(page), /gone 1127/, await screen(page));
  assert.deepEqual(page.errors, []);
});

test('mounts and unmounts a tmpfs with mount and umount', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(page, 'mount | grep -c "^proc on /proc type proc" | sed "s/^/proc mounted /"');
  await shows(page, 'proc mounted 1');
  await run(
    page,
    'mkdir -p /tmp/m && mount -t tmpfs none /tmp/m && echo "hi $((20 + 22))" > /tmp/m/f && cat /tmp/m/f && mount -t tmpfs | grep -c "^none on /tmp/m type tmpfs" | sed "s/^/listed /" && umount /tmp/m && echo "unmounted $((5 * 5))"'
  );
  await shows(page, 'hi 42');
  await shows(page, 'listed 1');
  await shows(page, 'unmounted 25');
  await run(page, 'ls /tmp/m | wc -l | sed "s/^/left /"');
  await shows(page, 'left 0');
  await run(
    page,
    'mount -t tmpfs none /tmp/m; mount -t tmpfs none /tmp/m 2>/dev/null; echo "busy $((1000 + $?))"; umount /tmp/m'
  );
  await shows(page, 'busy 1032');
  await run(page, 'mount -t tmpfs none /tmp/nowhere 2>/dev/null; echo "missing $((1000 + $?))"');
  await shows(page, 'missing 1032');
  await run(page, 'mount -t nosuchfs none /tmp/m 2>/dev/null; echo "unknown $((1000 + $?))"');
  await shows(page, 'unknown 1032');
  await run(page, 'umount /tmp/m 2>/dev/null; echo "not mounted $((1000 + $?))"');
  await shows(page, 'not mounted 1032');
  await run(page, 'mount --bogus 2>/dev/null; echo "usage $((1000 + $?))"');
  await shows(page, 'usage 1001');
  assert.deepEqual(page.errors, []);
});
