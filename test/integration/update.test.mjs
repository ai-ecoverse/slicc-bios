import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, booted, eventually, installable, opfs, ready, run, shows, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const bash = 'node_modules/@ai-ecoverse/wasm-bash';
const shipped =
  'sha512-5ZV/N3qcfPBYfMYhGut9psL3RF7sKRvJ+1KBChnbFSntNFe4vEkR4WsTBIrMIlItJm20bG3NFUFVR2tYDa/MPQ==';
const older =
  'sha512-XNfXF1z2vQvZuEYNm9D1n+mBRGWu4G0B8mkibEOKUpIhdaf/hkp8KCJzBtGMu4rkMb8AlqDSyTjI3RHyTqMD8w==';
const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml'];

async function downgrade() {
  for (const file of files) {
    const text = await readFile(new URL(`../../src/packages/${file}`, import.meta.url), 'utf8');
    const pinned = text.replaceAll('5.3.0-8', '5.3.0-7').replaceAll(shipped, older);
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

async function row(page, id) {
  return page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === id),
    id
  );
}

async function updated(page) {
  deploy();
  chrome.cdn.requests.length = 0;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.until(() =>
    /ready|failed/.test(
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'bios').state
    )
  );
  const bios = await row(page, 'bios');
  assert.equal(bios.state, 'ready', bios.error);
}

async function bootOlder(page) {
  await downgrade();
  await boot(page);
  assert.equal(await version(page), '5.3.0-7');
  assert.equal((await row(page, 'bios')).state, 'current');
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
  assert.ok(npm.length >= 13);
  assert.deepEqual(npm.sort(), pnpm.sort());
});

async function reload(page) {
  await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
  await page.until(
    () =>
      !!document
        .querySelector('slicc-app')
        .dock.content('updates')
        ?.shadowRoot?.querySelector('article[data-id="bios"] swc-button[data-action="reload"]')
  );
  await page.screenshot(new URL('updates-panel.png', page.dir));
  await page.evaluate(() => {
    window.stale = true;
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      .shadowRoot.querySelector('article[data-id="bios"] swc-button[data-action="reload"]')
      .click();
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
    const bios = await row(page, 'bios');
    assert.deepEqual(
      [bios.log, bios.actions, bios.from],
      ['@ai-ecoverse/wasm-bash 5.3.0-7 → 5.3.0-8', ['reload'], bios.to]
    );
    await page.until(
      () =>
        document.querySelector('slicc-app').model.updates.ready() &&
        !document.querySelector('slicc-app').dock.api.getPanel('updates')
    );
    assert.match(
      await page.evaluate(
        () => document.querySelector('slicc-app').shadowRoot.querySelector('#updates')?.textContent
      ),
      /Update ready|Updating \d/
    );
    assert.equal(await version(page), '5.3.0-8');
    assert.equal(
      await read(page, 'var/lib/slicc/pnpm-lock.yaml'),
      await readFile(new URL('../../src/packages/pnpm-lock.yaml', import.meta.url), 'utf8')
    );
    assert.deepEqual(
      chrome.cdn.requests.filter((url) => url.includes('/wasm-bash/')),
      ['https://registry.npmjs.org/@ai-ecoverse/wasm-bash/-/wasm-bash-5.3.0-8.tgz']
    );
    await page.screenshot(new URL('updated.png', page.dir));

    await run(
      page,
      `echo "$session $(bash -c 'head -3 /${bash}/package.json' | tail -1 | tr -d ' ')"`
    );
    await shows(page, 'kept "version":"5.3.0-8",');
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
      assert.equal(bios.texts('packages').at(-1), `0/${installable} downloaded from npm, 0B`);
      assert.deepEqual(
        chrome.cdn.requests.filter((url) => url.endsWith('.tgz')),
        []
      );
      assert.equal(await version(page), '5.3.0-8');
      assert.equal((await row(page, 'bios')).state, 'current');
      await run(page, 'cat work/notes.txt');
      await shows(page, 'draft');
      assert.deepEqual(page.errors, []);
    }
  );
});

test('installs the grammars with pnpm in the background and serves them from OPFS', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.equal(await page.evaluate(() => document.querySelector('slicc-app').grammarBase), null);
  assert.equal((await opfs(page)).filter((path) => path.includes('@shikijs')).length, 0);
  await page.until(() => document.querySelector('slicc-app').grammarBase !== null);
  const base = await page.evaluate(() => document.querySelector('slicc-app').grammarBase);
  assert.equal(base, new URL('/opt/grammars/node_modules/@shikijs/', chrome.url).href);
  const served = await page.evaluate(async (base) => {
    const response = await fetch(new URL('langs/dist/rust.mjs', base));
    return [response.status, (await response.text()).includes('rust')];
  }, base);
  assert.deepEqual(served, [200, true]);
  const grammars = await row(page, 'grammars');
  assert.deepEqual([grammars.state, grammars.from], ['installed', '4.5.0']);
  assert.equal(
    await read(page, 'var/lib/slicc/grammars/pnpm-lock.yaml'),
    await readFile(new URL('../../src/packages/grammars/pnpm-lock.yaml', import.meta.url), 'utf8')
  );

  await page.reload();
  await ready(page);
  assert.equal(await page.evaluate(() => document.querySelector('slicc-app').grammarBase), base);
  assert.deepEqual(page.errors, []);
});
