import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, booted, eventually, ready, run, shows, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const bash = 'node_modules/@ai-ecoverse/wasm-bash';
const shipped =
  'sha512-XNfXF1z2vQvZuEYNm9D1n+mBRGWu4G0B8mkibEOKUpIhdaf/hkp8KCJzBtGMu4rkMb8AlqDSyTjI3RHyTqMD8w==';
const older =
  'sha512-4mwVr9PT6JHJygxiJT9uWJFnf5PRo3n6TvoHVQ5sYm0V0mi1nQB6j/4r9VXSsQsXhgwcbEkeXu2L1FwHqWbWWw==';
const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml'];

async function downgrade() {
  for (const file of files) {
    const text = await readFile(new URL(`../../src/packages/${file}`, import.meta.url), 'utf8');
    const pinned = text.replaceAll('5.3.0-7', '5.3.0-6').replaceAll(shipped, older);
    chrome.overrides.set(`/packages/${file}`, pinned);
  }
}

function deploy() {
  for (const file of files) chrome.overrides.delete(`/packages/${file}`);
}

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

async function version(page) {
  return JSON.parse(await read(page, `${bash}/package.json`)).version;
}

async function notice(page) {
  return page.evaluate(() => {
    const notice = document.querySelector('.update');
    return { hidden: notice.hidden, state: notice.dataset.state, text: notice.textContent };
  });
}

async function updated(page) {
  deploy();
  chrome.cdn.requests.length = 0;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.until(() => /ready|failed/.test(document.querySelector('.update').dataset.state));
  assert.equal((await notice(page)).state, 'ready');
}

async function bootOlder(page) {
  await downgrade();
  await boot(page);
  assert.equal(await version(page), '5.3.0-6');
  assert.equal((await notice(page)).hidden, true);
}

test('pins the same packages in the bootstrap and the pnpm lockfile', async () => {
  const source = (file) => readFile(new URL(`../../src/packages/${file}`, import.meta.url), 'utf8');
  const npm = Object.entries(JSON.parse(await source('package-lock.json')).packages)
    .filter(([path]) => path)
    .map(
      ([path, { version, integrity }]) =>
        `${path.split('node_modules/').at(-1)}@${version} ${integrity}`
    );
  const pnpm = [
    ...(await source('pnpm-lock.yaml')).matchAll(
      /^ {2}'?(\S+?)'?:\n {4}resolution: \{integrity: (\S+)\}/gm
    ),
  ].map(([, id, integrity]) => `${id} ${integrity}`);
  assert.equal(npm.length, 19);
  assert.deepEqual(npm.sort(), pnpm.sort());
});

async function reload(page) {
  await page.evaluate(() => {
    window.stale = true;
    document.querySelector('.update button').click();
  });
  await page.until(() => !window.stale && location.pathname === '/os/');
  await ready(page);
}

test('updates a running install from a bumped lockfile', async (t) => {
  const page = await chrome.page(t);
  await bootOlder(page);
  await run(page, 'session=kept; mkdir work; echo draft > work/notes.txt; echo ok"k"');
  await shows(page, 'okk');

  await t.test('installs the new version in place while the shell keeps running', async () => {
    await updated(page);
    const { text } = await notice(page);
    assert.equal(text.trim(), 'updated @ai-ecoverse/wasm-bash 5.3.0-6 → 5.3.0-7Reload');
    assert.equal(await version(page), '5.3.0-7');
    assert.equal(
      await read(page, 'var/lib/slicc/pnpm-lock.yaml'),
      await readFile(new URL('../../src/packages/pnpm-lock.yaml', import.meta.url), 'utf8')
    );
    assert.deepEqual(
      chrome.cdn.requests.filter((url) => url.includes('/wasm-bash/')),
      ['https://registry.npmjs.org/@ai-ecoverse/wasm-bash/-/wasm-bash-5.3.0-7.tgz']
    );
    await page.screenshot(new URL('updated.png', page.dir));

    await run(
      page,
      `echo "$session $(bash -c 'head -3 /${bash}/package.json' | tail -1 | tr -d ' ')"`
    );
    await shows(page, 'kept "version":"5.3.0-7",');
  });

  await t.test('keeps what the shell wrote across the update', async () => {
    assert.equal(await read(page, 'home/work/notes.txt'), 'draft\n');
  });

  await t.test(
    'reloads onto the new version through the BIOS without downloading it again',
    async () => {
      chrome.cdn.requests.length = 0;
      const bios = await watch(page);
      await reload(page);
      await eventually(() => assert.deepEqual(bios.states(), booted));
      assert.equal(bios.texts('packages').at(-1), '0/19 downloaded from npm, 0B');
      assert.deepEqual(
        chrome.cdn.requests.filter((url) => url.endsWith('.tgz')),
        []
      );
      assert.equal(await version(page), '5.3.0-7');
      assert.equal((await notice(page)).hidden, true);
      await run(page, 'cat work/notes.txt');
      await shows(page, 'draft');
      assert.deepEqual(page.errors, []);
    }
  );
});
