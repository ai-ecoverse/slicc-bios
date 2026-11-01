import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, booted, eventually, installable, opfs, watch } from './bios.mjs';
import { launch } from './chrome.mjs';
import { seedFiles } from './seed.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const seed = await seedFiles();
const shipped = JSON.parse(
  await readFile(new URL('../../src/packages/package.json', import.meta.url), 'utf8')
);

test('boots through every step into the UI served from OPFS', async (t) => {
  const page = await chrome.page(t);
  const bios = await watch(page);
  await boot(page);

  assert.deepEqual(bios.states(), booted);
  const ui = page.responses.find((response) => new URL(response.url).pathname === '/os/');
  assert.equal(ui.fromServiceWorker, true);
  assert.equal(ui.headers['x-served-from'], 'opfs');
  assert.ok(!chrome.requests.includes('/os/'));
  await eventually(() => assert.deepEqual(bios.reveals(), ['/:true:false', '/os/:true:true']));
  assert.deepEqual(page.errors, []);

  const files = await opfs(page);
  for (const name of Object.keys(shipped.dependencies)) {
    assert.ok(files.includes(`node_modules/${name}/package.json`), name);
    assert.ok(files.includes(`var/lib/bios/node_modules/${name}.json`), name);
  }
  assert.deepEqual(
    files.filter((path) => path.startsWith('os/')),
    seed.map((name) => `os/${name}`).sort()
  );
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal(ui.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(ui.headers['cross-origin-embedder-policy'], 'require-corp');
});

test('reports each step and the download as it happens', async (t) => {
  const page = await chrome.page(t);
  const bios = await watch(page);
  await boot(page);

  const [opfs] = bios.texts('opfs');
  assert.match(opfs, /^(persistent|best effort), [\d,.]+[kMG]?B free$/);
  assert.deepEqual(bios.texts('installer'), ['connection #1']);
  assert.match(bios.texts('packages')[0], new RegExp(`^1/${installable} node_modules/[@\\w./-]+$`));
  assert.match(
    bios.texts('packages').at(-1),
    new RegExp(`^${installable}/${installable} downloaded from npm, [\\d.]+MB$`)
  );
  const [installed] = bios.texts('seed');
  assert.ok(installed.startsWith(`os/{${seed.join(',')}} `), installed);
  assert.match(installed, / [\d.]+kB$/);
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
  assert.match(
    state.error,
    /^404 https:\/\/registry\.npmjs\.org\/@ai-ecoverse\/[\w-]+\/-\/[\w.-]+\.tgz$/
  );
  assert.deepEqual([state.seed, state.progress, state.path], [undefined, 2, '/']);
});

test('halts at the packages step when a tarball fails its integrity check', async (t) => {
  const page = await chrome.page(t);
  chrome.cdn.corrupt = true;
  await page.goto('/');

  const state = await halted(page);
  assert.match(state.error, /^integrity mismatch for node_modules\/@ai-ecoverse\/[\w-]+$/);
  assert.deepEqual([state.seed, state.progress, state.path], [undefined, 2, '/']);
  const opfs = await page.evaluate(async () => {
    const names = [];
    for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name);
    return names;
  });
  assert.ok(!opfs.includes('node_modules'));
});

test('goes on under the active worker when an updated one waits and never activates', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
  const stuck = current
    .replace(
      "self.addEventListener('install', () => self.skipWaiting());",
      "self.addEventListener('install', () => {});"
    )
    .replace('    self.skipWaiting();\n    return;', '    return;');
  assert.notEqual(stuck, current);
  chrome.overrides.set('/sw.js', stuck);
  const bios = await watch(page);
  const warnings = [];
  const off = chrome.cdp.on(({ method, params }) => {
    if (method === 'Runtime.consoleAPICalled' && params.type === 'warning')
      warnings.push(params.args.map((arg) => arg.value).join(' '));
  });
  const started = Date.now();
  await boot(page);
  off();
  chrome.overrides.delete('/sw.js');
  assert.deepEqual(bios.states(), booted);
  assert.ok(Date.now() - started < 60000);
  assert.deepEqual(
    warnings.filter((text) => text.startsWith('bios:')),
    [
      `bios: ${new URL('sw.js', chrome.url).href} is still installed, going on under the active worker`,
    ]
  );
  assert.deepEqual(page.errors, []);
});

async function uncontrolledReload(page, marker) {
  const os = new URL('../../src/seed/', import.meta.url);
  for (const name of ['index.html', 'os.css', 'start.js'])
    chrome.overrides.set(`/os/${name}`, await readFile(new URL(name, os), 'utf8'));
  await page.evaluate(async (marker) => {
    if (marker) sessionStorage.setItem('slicc-os.uncontrolled', String(Date.now()));
    else sessionStorage.removeItem('slicc-os.uncontrolled');
    for (const registration of await navigator.serviceWorker.getRegistrations())
      await registration.unregister();
    window.before765 = true;
  }, marker);
  const before = chrome.requests.length;
  await page.send('Page.navigate', { url: new URL('/os/index.html', chrome.url).href });
  return before;
}

test('an /os/ page that loads without seven’s service worker goes back through the BIOS once and ends booted, not stalled (#765)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const before = await uncontrolledReload(page, false);
  await page.within(
    60000,
    () =>
      !window.before765 &&
      location.pathname.startsWith('/os/') &&
      !!navigator.serviceWorker.controller &&
      !!document
        .querySelector('slicc-app')
        ?.dock?.api.panels.some((panel) => panel.id.startsWith('terminal:'))
  );
  const seen = chrome.requests.slice(before);
  assert.ok(seen.includes('/os/start.js'), 'seven’s start loaded without the worker');
  assert.ok(seen.includes('/bios.js'), 'the page went back through the BIOS');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('slicc-os.uncontrolled')), null);
  assert.deepEqual(page.errors, []);
});

async function shots(page, name) {
  for (const [color, width] of [
    ['light', 1280],
    ['dark', 1280],
    ['light', 420],
  ]) {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: color }],
    });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.screenshot(new URL(`${name}-${color}-${width}.png`, page.dir));
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
}

test('a boot that fails while it runs shows the error, not a claim about its files', async (t) => {
  const page = await chrome.page(t);
  chrome.overrides.set('/seed/os.js', "throw new Error('the UI failed on purpose');\n");
  await page.goto('/');
  const text = await page.until(() => document.querySelector('[data-refused] p')?.textContent);
  assert.equal(
    text,
    'Seven has no record of a changed file, but it stopped while starting: Error: the UI failed on purpose'
  );
  await shots(page, 'start-no-record');
});

test('a boot that fails with no answer from the service worker claims nothing about its files', async (t) => {
  const page = await chrome.page(t);
  chrome.overrides.set('/seed/os.js', "throw new Error('the UI failed on purpose');\n");
  await page.init(() => {
    const send = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) =>
      String(input).endsWith('/__slicc/integrity')
        ? Promise.reject(new TypeError('no answer'))
        : send(input, init);
  });
  await page.goto('/');
  const text = await page.until(() => document.querySelector('[data-refused] p')?.textContent);
  assert.equal(text, 'Seven stopped while starting: Error: the UI failed on purpose');
});

test('an /os/ page that is still without its service worker after one trip through the BIOS stops there and says why, with no second trip (#765)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const before = await uncontrolledReload(page, true);
  await page.within(30000, () => !window.before765 && !!document.querySelector('[data-refused]'));
  assert.equal(await page.evaluate(() => location.pathname), '/os/index.html');
  assert.equal(
    await page.evaluate(() => document.querySelector('[data-refused] p').textContent),
    'Seven’s service worker isn’t running in this page, so seven couldn’t load its code. Reloading goes through the BIOS, which starts it again.'
  );
  await shots(page, 'start-no-worker');
  assert.equal(chrome.requests.slice(before).includes('/bios.js'), false, 'no second trip');
});
