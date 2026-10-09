import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, ready, run, screen, shows, ui } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';

async function opened(t) {
  const chrome = await launch();
  const proxy = await fakeProxy({
    origin: new URL(chrome.url).origin,
    key: 'the-key',
    exports: { project: { 'hello.txt': 'hello from the host\n' } },
  });
  t.after(async () => {
    await proxy.close();
    await chrome.close();
  });
  return { page: await chrome.page(t), proxy };
}

async function picker(page) {
  await page.init(() => {
    window.filesPanel = () => document.querySelector('slicc-app').dock.content('files').shadowRoot;
    window.picked = 0;
    window.showDirectoryPicker = async () => {
      window.picked++;
      const root = await navigator.storage.getDirectory();
      const tmp = await root.getDirectoryHandle('tmp', { create: true });
      return tmp.getDirectoryHandle('picked', { create: true });
    };
  });
}

const waiting = (page, target) =>
  page.evaluate((target) => {
    const needs = document.querySelector('slicc-app').model.files.needsFolder().includes(target);
    const button = window
      .filesPanel()
      .querySelector(`[data-action="insert-folder"][data-id="${target}"]`);
    return { needs, button: button?.textContent.trim() ?? null };
  }, target);
const until = (page, target, needs) =>
  page.until(
    ([target, needs]) =>
      document.querySelector('slicc-app').model.files.needsFolder().includes(target) === needs &&
      !!window.filesPanel().querySelector(`[data-action="insert-folder"][data-id="${target}"]`) ===
        needs,
    [target, needs]
  );

const remembered = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('slicc-os.mounts') ?? '[]'));
const mounts = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.files.mounts());

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test('off the record, a shell fsa mount asks for a folder in the Files panel, works and is not kept', async (t) => {
  const { page } = await opened(t);
  await ui(page);
  await picker(page);
  await boot(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.folders), 'session');
  await run(
    page,
    'mkdir -p /tmp/picked /mnt/x && echo "from the folder $((6 * 7))" > /tmp/picked/hello.txt && mount -t fsa none /mnt/x && mount | grep -c "on /mnt/x type fsa (rw,nomedium)" | sed "s/^/pending /"'
  );
  await shows(page, 'pending 1');
  await until(page, '/mnt/x', true);
  assert.deepEqual(await waiting(page, '/mnt/x'), { needs: true, button: 'Insert folder…' });
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('[slot="status"]:not([hidden])').length),
    0
  );
  await page.screenshot(new URL('needs-folder.png', page.dir));

  await page.evaluate(() =>
    window.filesPanel().querySelector('[data-action="insert-folder"][data-id="/mnt/x"]').click()
  );
  await until(page, '/mnt/x', false);
  assert.equal(await page.evaluate(() => window.picked), 1);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.folders), 'session');
  await run(
    page,
    'cat /mnt/x/hello.txt; echo "made $((2 + 3))" > /mnt/x/made.txt && echo "written $((3 + 4))"'
  );
  await shows(page, 'from the folder 42');
  await shows(page, 'written 7');
  assert.equal(await read(page, 'tmp/picked/made.txt'), 'made 5\n');
  await page.until(() => window.ui.tree().paths.includes('mnt/x/made.txt'));
  assert.deepEqual(await mounts(page), ['/mnt/x']);
  assert.deepEqual(await remembered(page), []);
  assert.equal(
    await page.evaluate(async () =>
      (await indexedDB.databases()).some((database) => database.name.endsWith(':media'))
    ),
    false
  );

  await run(page, 'umount /mnt/x && echo "ejected $((3 * 3))"');
  await shows(page, 'ejected 9');
  await page.until(() => document.querySelector('slicc-app').model.files.mounts().length === 0);
  assert.equal(await read(page, 'tmp/picked/made.txt'), 'made 5\n');

  await run(page, 'mount -t fsa none /mnt/x && echo "again $((8 * 8))"');
  await shows(page, 'again 64');
  await until(page, '/mnt/x', true);
  await page.reload();
  await ready(page);
  await run(page, 'mount | grep -c "/mnt/x" | sed "s/^/after reload /"');
  await shows(page, 'after reload 0');
  assert.deepEqual(await waiting(page, '/mnt/x'), { needs: false, button: null });

  await run(
    page,
    'mkdir -p /mnt/h; mount -t hostfs project /mnt/h; echo "no proxy $((1000 + $?))"'
  );
  await shows(page, 'no proxy 1032');
  assert.match(await screen(page), /hostfs is not available here \(no host connection\)/);
  assert.deepEqual(page.errors, []);
});

test('Mount a folder and Eject in the Files panel mount and unmount a picked folder, and the Mounted strip follows the shell', async (t) => {
  const { page } = await opened(t);
  await ui(page);
  await picker(page);
  await boot(page);
  await run(
    page,
    'mkdir -p /tmp/picked && echo "tree $((4 * 4))" > /tmp/picked/leaf.txt && cat /tmp/picked/leaf.txt'
  );
  await shows(page, 'tree 16');
  await page.until(() => !!window.filesPanel().querySelector('[data-action="mount-folder"]'));
  await page.evaluate(() =>
    window.filesPanel().querySelector('[data-action="mount-folder"]').click()
  );
  await page.until(() => window.ui.tree().paths.includes('mnt/picked/leaf.txt'));
  assert.equal(await page.evaluate(() => window.picked), 1);
  assert.deepEqual(await mounts(page), ['/mnt/picked']);
  assert.deepEqual(await waiting(page, '/mnt/picked'), { needs: false, button: null });
  await page.until(
    () => !!window.filesPanel().querySelector('[data-action="eject"][data-path="/mnt/picked"]')
  );
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('slicc-app').model.files.read('/mnt/picked/leaf.txt')
    ),
    'tree 16\n'
  );
  await page.evaluate(() =>
    window.filesPanel().querySelector('[data-action="eject"][data-path="/mnt/picked"]').click()
  );
  await page.until(() => document.querySelector('slicc-app').model.files.mounts().length === 0);
  await page.until(() => !window.filesPanel().querySelector('[data-action="eject"]'));
  await page.until(() => !window.ui.tree().paths.includes('mnt/picked/leaf.txt'));
  await run(page, 'mount | grep -c "/mnt/picked" | sed "s/^/still /"');
  await shows(page, 'still 0');

  await run(page, 'mkdir -p /mnt/y && mount -t fsa none /mnt/y && echo "asked $((5 * 5))"');
  await shows(page, 'asked 25');
  await until(page, '/mnt/y', true);
  await page.until(
    () => !!window.filesPanel().querySelector('[data-action="eject"][data-path="/mnt/y"]')
  );
  await run(page, 'umount /mnt/y && echo "gone $((6 * 6))"');
  await shows(page, 'gone 36');
  await until(page, '/mnt/y', false);
  assert.deepEqual(page.errors, []);
});

test('mount -t hostfs mounts a folder the local proxy exports, with a grant the shell never sees', async (t) => {
  const { page, proxy } = await opened(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await ready(page);
  await run(
    page,
    'mkdir -p /mnt/p && mount -t hostfs -o ro project /mnt/p && cat /mnt/p/hello.txt && grep -c "^project /mnt/p hostfs ro" /proc/mounts | sed "s/^/listed /"'
  );
  await shows(page, 'hello from the host');
  await shows(page, 'listed 1');
  const [token] = proxy.grants.keys();
  assert.ok(token);
  await run(page, `grep -c "${token.slice(0, 12)}" /proc/mounts | sed "s/^/leaked /"`);
  await shows(page, 'leaked 0');
  await page.until(() =>
    document.querySelector('slicc-app').model.files.mounts().includes('/mnt/p')
  );
  assert.deepEqual(await remembered(page), [
    { type: 'hostfs', source: 'project', target: '/mnt/p', options: { ro: '' } },
  ]);

  await page.reload();
  await ready(page);
  await page.until(() =>
    document.querySelector('slicc-app').model.files.mounts().includes('/mnt/p')
  );
  await run(page, 'cat /mnt/p/hello.txt | tr a-z A-Z');
  await shows(page, 'HELLO FROM THE HOST');

  await run(
    page,
    'mkdir -p /mnt/q; mount -t hostfs elsewhere /mnt/q; echo "refused $((1000 + $?))"'
  );
  await shows(page, 'refused 1032');
  assert.deepEqual(page.errors, []);
});
