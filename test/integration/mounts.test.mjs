import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run, screen, shows, ui } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';

const chrome = await launch();
const proxy = await fakeProxy({
  origin: new URL(chrome.url).origin,
  key: 'the-key',
  exports: { project: { 'hello.txt': 'hello from the host\n' } },
});
after(async () => {
  await proxy.close();
  await chrome.close();
});

async function picker(page, { quota } = {}) {
  await page.init((quota) => {
    window.picked = 0;
    window.showDirectoryPicker = async () => {
      window.picked++;
      const root = await navigator.storage.getDirectory();
      const tmp = await root.getDirectoryHandle('tmp', { create: true });
      return tmp.getDirectoryHandle('picked', { create: true });
    };
    if (quota) navigator.storage.estimate = async () => ({ quota, usage: 0 });
  }, quota);
}

const notice = (page, target) =>
  page.evaluate((target) => {
    const element = document.querySelector(`.mount[data-target="${target}"]`);
    if (!element) return null;
    const [output, button] = element.children;
    return {
      slot: element.slot,
      role: element.getAttribute('role'),
      text: output.value,
      button: button.textContent,
    };
  }, target);

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

test('mount -t fsa from the shell asks for a folder in the notice strip and stays mounted across a reload', async (t) => {
  const page = await chrome.page(t);
  await ui(page);
  await picker(page);
  await boot(page);
  await run(
    page,
    'mkdir -p /tmp/picked /mnt/x && echo "from the folder $((6 * 7))" > /tmp/picked/hello.txt && mount -t fsa none /mnt/x && mount | grep -c "on /mnt/x type fsa (rw,nomedium)" | sed "s/^/pending /"'
  );
  await shows(page, 'pending 1');
  await page.until(() => !!document.querySelector('.mount[data-target="/mnt/x"]'));
  assert.deepEqual(await notice(page, '/mnt/x'), {
    slot: 'status',
    role: 'status',
    text: '/mnt/x needs a folder',
    button: 'Insert folder',
  });

  await page.evaluate(() => document.querySelector('.mount[data-target="/mnt/x"] button').click());
  await page.until(() => !document.querySelector('.mount[data-target="/mnt/x"]'));
  assert.equal(await page.evaluate(() => window.picked), 1);
  await run(page, 'cat /mnt/x/hello.txt; echo "made $((2 + 3))" > /mnt/x/made.txt');
  await shows(page, 'from the folder 42');
  assert.equal(await read(page, 'tmp/picked/made.txt'), 'made 5\n');
  await page.until(() => window.ui.tree().paths.includes('mnt/x/made.txt'));
  assert.deepEqual(await mounts(page), ['/mnt/x']);
  const [stored] = await remembered(page);
  assert.equal(stored.type, 'fsa');
  assert.equal(stored.target, '/mnt/x');
  assert.match(stored.source, /^fsa:[0-9a-f-]{36}$/);

  await page.reload();
  await ready(page);
  await page.until(() => document.querySelector('slicc-app').model.files.mounts().length === 1);
  await run(
    page,
    'cat /mnt/x/made.txt; mount | grep -c "^fsa:.* on /mnt/x type fsa (rw)$" | sed "s/^/again /"'
  );
  await shows(page, 'made 5');
  await shows(page, 'again 1');
  assert.equal(await notice(page, '/mnt/x'), null);
  assert.equal(await page.evaluate(() => window.picked), 0);

  await run(page, 'umount /mnt/x && echo "ejected $((3 * 3))"');
  await shows(page, 'ejected 9');
  await page.until(() => document.querySelector('slicc-app').model.files.mounts().length === 0);
  assert.deepEqual(await remembered(page), []);
  assert.equal(await read(page, 'tmp/picked/made.txt'), 'made 5\n');

  await run(
    page,
    'mkdir -p /mnt/h; mount -t hostfs project /mnt/h; echo "no proxy $((1000 + $?))"'
  );
  await shows(page, 'no proxy 1032');
  assert.match(await screen(page), /unknown filesystem type 'hostfs'/);
  assert.deepEqual(page.errors, []);
});

test('the files port mounts a picked folder and ejects it, and the pending notice goes when the shell unmounts', async (t) => {
  const page = await chrome.page(t);
  await ui(page);
  await picker(page);
  await boot(page);
  await run(page, 'mkdir -p /tmp/picked && echo "tree $((4 * 4))" > /tmp/picked/leaf.txt');
  await shows(page, 'tree 16');
  const target = await page.evaluate(() =>
    document.querySelector('slicc-app').model.files.mountFolder()
  );
  assert.equal(target, '/mnt/picked');
  assert.equal(await notice(page, target), null);
  await page.until(() => window.ui.tree().paths.includes('mnt/picked/leaf.txt'));
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('slicc-app').model.files.read('/mnt/picked/leaf.txt')
    ),
    'tree 16\n'
  );
  await page.evaluate(() => document.querySelector('slicc-app').model.files.eject('/mnt/picked'));
  assert.deepEqual(await mounts(page), []);
  await run(page, 'mount | grep -c "/mnt/picked" | sed "s/^/still /"');
  await shows(page, 'still 0');

  await run(page, 'mkdir -p /mnt/y && mount -t fsa none /mnt/y && echo "asked $((5 * 5))"');
  await shows(page, 'asked 25');
  await page.until(() => !!document.querySelector('.mount[data-target="/mnt/y"]'));
  await run(page, 'umount /mnt/y && echo "gone $((6 * 6))"');
  await shows(page, 'gone 36');
  await page.until(() => !document.querySelector('.mount[data-target="/mnt/y"]'));
  assert.deepEqual(page.errors, []);
});

test('off the record, a folder mount is neither remembered nor mounted again after a reload', async (t) => {
  const page = await chrome.page(t);
  await picker(page, { quota: 100 * 1024 * 1024 });
  await boot(page);
  await run(page, 'mkdir -p /mnt/z && mount -t fsa none /mnt/z && echo "private $((7 * 7))"');
  await shows(page, 'private 49');
  await page.until(() => !!document.querySelector('.mount[data-target="/mnt/z"]'));
  await page.evaluate(() => document.querySelector('.mount[data-target="/mnt/z"] button').click());
  await page.until(() => !document.querySelector('.mount[data-target="/mnt/z"]'));
  assert.deepEqual(await mounts(page), ['/mnt/z']);
  assert.deepEqual(await remembered(page), []);

  await page.reload();
  await ready(page);
  await run(page, 'mount | grep -c "/mnt/z" | sed "s/^/after reload /"');
  await shows(page, 'after reload 0');
  assert.deepEqual(page.errors, []);
});

test('mount -t hostfs mounts a folder the local proxy exports, with a grant the shell never sees', async (t) => {
  const page = await chrome.page(t);
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

  await run(
    page,
    'mkdir -p /mnt/q; mount -t hostfs elsewhere /mnt/q 2>/dev/null; echo "refused $((1000 + $?))"'
  );
  await shows(page, 'refused 1032');
  assert.deepEqual(page.errors, []);
});
