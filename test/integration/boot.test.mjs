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
    /^bin\/bash[\d.]+kB$/,
    /^bin\/bash\.wasm[\d.]+MB$/,
    /^os\/index\.html[\d.]+k?B$/,
    /^os\/os\.css[\d.]+k?B$/,
    /^os\/os\.js[\d.]+k?B$/,
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
  assert.ok(bios.texts('bash').some((text) => /^bin\/bash\.wasm [\d.]+MB$/.test(text)));
  assert.match(bios.texts('bash').at(-1), /^bin\/bash, bin\/bash\.wasm 5\.\dMB$/);
  assert.match(bios.texts('seed')[0], /^os\/\{index\.html,os\.css,os\.js\} [\d.]+kB$/);
  const origin = await page.evaluate(() => new URL('/', location).href);
  assert.deepEqual(bios.texts('intercept'), [origin]);
  assert.deepEqual(bios.texts('navigate'), ['/os/']);
});

test('halts at the failing step when wasm bash cannot be downloaded', async (t) => {
  const page = await chrome.page(t);
  chrome.cdn.status = 404;
  await page.goto('/');
  await page.until(() => document.querySelector('[data-step="bash"]').dataset.state === 'failed');

  const state = await page.evaluate(() => ({
    error: document.querySelector('[data-step="bash"] output').value,
    seed: document.querySelector('[data-step="seed"]').dataset.state,
    progress: document.querySelector('progress').value,
    path: location.pathname,
  }));
  assert.match(
    state.error,
    /^404 https:\/\/cdn\.jsdelivr\.net\/npm\/@ai-ecoverse\/wasm-bash@[^/]+\/bin\/bash$/
  );
  assert.equal(state.seed, undefined);
  assert.equal(state.progress, 2);
  assert.equal(state.path, '/');
});
