import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, booted, eventually, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('boots through every step into the UI served from OPFS', async (t) => {
  const page = await chrome.page(t);
  const bios = await watch(page);
  await boot(page);

  assert.deepEqual(bios.states(), booted);
  const ui = page.responses.find((response) => new URL(response.url).pathname === '/os/');
  assert.equal(ui.fromServiceWorker, true);
  assert.equal(ui.headers['x-served-from'], 'opfs');
  assert.ok(!chrome.requests.includes('/os/'));
  await eventually(() => assert.deepEqual(bios.reveals(), ['/:true', '/os/:true']));
  assert.deepEqual(page.errors, []);

  const files = await page.evaluate(() =>
    [...document.querySelectorAll('#files li')].map((item) => item.textContent)
  );
  const expected = [
    /^node_modules\/@ai-ecoverse\/wasm-bash\/LICENSE[\d.]+kB$/,
    /^node_modules\/@ai-ecoverse\/wasm-bash\/README\.md\d+B$/,
    /^node_modules\/@ai-ecoverse\/wasm-bash\/bin\/bash[\d.]+kB$/,
    /^node_modules\/@ai-ecoverse\/wasm-bash\/bin\/bash\.wasm[\d.]+MB$/,
    /^node_modules\/@ai-ecoverse\/wasm-bash\/package\.json\d+B$/,
    /^os\/index\.html[\d.]+k?B$/,
    /^os\/os\.css[\d.]+k?B$/,
    /^os\/os\.js[\d.]+k?B$/,
    /^var\/lib\/bios\/node_modules\/@ai-ecoverse\/wasm-bash\.json\d+B$/,
  ];
  assert.equal(files.length, expected.length);
  for (const [i, pattern] of expected.entries()) assert.match(files[i], pattern);
});

test('reports each step and the download as it happens', async (t) => {
  const page = await chrome.page(t);
  const bios = await watch(page);
  await boot(page);

  const [opfs] = bios.texts('opfs');
  assert.match(opfs, /^(persistent|best effort), [\d,.]+[kMG]?B free$/);
  assert.deepEqual(bios.texts('kernel'), ['connection #1']);
  assert.equal(bios.texts('packages')[0], '1/1 node_modules/@ai-ecoverse/wasm-bash');
  assert.match(bios.texts('packages').at(-1), /^1\/1 downloaded from npm, [\d.]+MB$/);
  assert.match(bios.texts('seed')[0], /^os\/\{index\.html,os\.css,os\.js\} [\d.]+kB$/);
  const origin = await page.evaluate(() => new URL('/', location).href);
  assert.deepEqual(bios.texts('intercept'), [origin]);
  assert.deepEqual(bios.texts('navigate'), ['/os/']);
});

async function halted(page) {
  await page.until(
    () => document.querySelector('[data-step="packages"]').dataset.state === 'failed'
  );
  return page.evaluate(() => ({
    error: document.querySelector('[data-step="packages"] output').value,
    seed: document.querySelector('[data-step="seed"]').dataset.state,
    progress: document.querySelector('progress').value,
    path: location.pathname,
  }));
}

test('halts at the packages step when npm cannot deliver a tarball', async (t) => {
  const page = await chrome.page(t);
  chrome.cdn.status = 404;
  await page.goto('/');

  const state = await halted(page);
  assert.equal(
    state.error,
    '404 https://registry.npmjs.org/@ai-ecoverse/wasm-bash/-/wasm-bash-5.3.0-7.tgz'
  );
  assert.deepEqual([state.seed, state.progress, state.path], [undefined, 2, '/']);
});

test('halts at the packages step when a tarball fails its integrity check', async (t) => {
  const page = await chrome.page(t);
  chrome.cdn.corrupt = true;
  await page.goto('/');

  const state = await halted(page);
  assert.equal(state.error, 'integrity mismatch for node_modules/@ai-ecoverse/wasm-bash');
  assert.deepEqual([state.seed, state.progress, state.path], [undefined, 2, '/']);
  const opfs = await page.evaluate(async () => {
    const names = [];
    for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name);
    return names;
  });
  assert.ok(!opfs.includes('node_modules'));
});
