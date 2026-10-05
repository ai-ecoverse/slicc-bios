import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, booted, eventually, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('boots through every step into the page bash wrote into OPFS', async (t) => {
  const page = await chrome.page(t);
  const bios = await watch(page);
  await boot(page);

  assert.deepEqual(bios.states(), booted);
  const landing = page.responses.find(
    (response) => new URL(response.url).pathname === '/os/bash.html'
  );
  assert.equal(landing.fromServiceWorker, true);
  assert.equal(landing.headers['x-served-from'], 'opfs');
  assert.ok(!chrome.requests.includes('/os/bash.html'));
  await eventually(() => assert.deepEqual(bios.reveals(), ['/:true', '/os/bash.html:true']));
  assert.deepEqual(page.errors, []);

  const written = await page.evaluate(() => ({
    title: document.title,
    stamp: document.getElementById('written').textContent,
    seen: [...document.querySelectorAll('#seen li')].map((item) => item.textContent),
    link: document.querySelector('a').getAttribute('href'),
  }));
  assert.match(written.title, /^Hello from bash 5\.3\.\d+\(1\)-release$/);
  assert.match(
    written.stamp,
    /^Written by boot\.sh in the shared worker at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/
  );
  assert.deepEqual(written.seen, ['index.html', 'os.css', 'os.js']);
  assert.equal(written.link, './');
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
  assert.deepEqual(bios.texts('script'), ['wrote os/bash.html after seeing 3 files in os/']);
  assert.deepEqual(bios.texts('intercept'), [origin]);
  assert.deepEqual(bios.texts('navigate'), ['/os/bash.html']);
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

test('halts at the script step when the boot script fails', async (t) => {
  const page = await chrome.page(t);
  chrome.overrides.set('/boot.sh', 'echo "boot.sh is broken" >&2\nexit 3\n');
  await page.goto('/');
  await page.until(() => document.querySelector('[data-step="script"]').dataset.state === 'failed');

  const state = await page.evaluate(() => ({
    error: document.querySelector('[data-step="script"] output').value,
    intercept: document.querySelector('[data-step="intercept"]').dataset.state,
    progress: document.querySelector('progress').value,
    path: location.pathname,
  }));
  assert.equal(state.error, 'bash exited with 3: boot.sh is broken');
  assert.equal(state.intercept, undefined);
  assert.equal(state.progress, 4);
  assert.equal(state.path, '/');
});
