import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { booted, ready, watch } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';
import { PROXY_ERROR, startWww } from './fake-six.mjs';

const chrome = await launch({ tools: false });
const www = await startWww(new URL(chrome.url));
const { origin, state } = www;
after(async () => {
  await www.close();
  await chrome.close();
});

const lock = JSON.parse(
  readFileSync(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8')
);
const tarball = lock.packages['node_modules/@ai-ecoverse/slicc-capture'].resolved;

async function open(t) {
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(origin)} && !localStorage.getItem(${JSON.stringify(VAULT_KEY)})) localStorage.setItem(${JSON.stringify(VAULT_KEY)}, ${JSON.stringify(chrome.vault.origin)}); }`
  );
  return page;
}

async function sixTab(page) {
  await page.goto(`${origin}/six-tab.html`);
  await page.until(() => document.getElementById('six')?.dataset.proxied === 'yes');
}

function probe(page, url = tarball) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    const body = response.type === 'cors' ? null : await response.text();
    return { status: response.status, type: response.type, body };
  }, url);
}

function keepInstaller(page) {
  return page.evaluate(async () => {
    window.kept = new SharedWorker('/7/installer.js', 'slicc-installer');
    window.kept.port.start();
    return navigator.serviceWorker.controller?.scriptURL;
  });
}

const steps = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-step]')].map((item) => [
        item.dataset.step,
        { state: item.dataset.state ?? null, text: item.querySelector('output').value },
      ])
    )
  );

const registered = (page) =>
  page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
      scope: new URL(registration.scope).pathname,
      script: new URL(registration.active?.scriptURL ?? 'about:blank').pathname,
    }))
  );

test("SLICC 6's proxy worker answers a cross-origin download with its 404 under npm's URL", async (t) => {
  state.proxy = 'old';
  const page = await open(t);
  await sixTab(page);
  assert.deepEqual(await probe(page), {
    status: 404,
    type: 'basic',
    body: JSON.stringify({ error: PROXY_ERROR }),
  });
});

test("an installer already running under an old SLICC 6 worker fails its first download saying a service worker answered, not with npm's 404", async (t) => {
  state.proxy = 'old';
  const holder = await open(t);
  await sixTab(holder);
  assert.equal(await keepInstaller(holder), `${origin}/llm-proxy-sw.js`);

  const page = await holder.tab();
  const bios = await watch(page);
  await page.goto(`${origin}/7/`);
  await page.until(
    () => document.querySelector('[data-step="packages"]')?.dataset.state === 'failed'
  );
  const seen = await steps(page);
  assert.equal(seen.installer.state, 'done');
  assert.equal(seen.installer.text, "connection #2, SLICC 6's service worker unregistered");
  assert.match(
    seen.packages.text,
    new RegExp(
      `^404 https://registry\\.npmjs\\.org/\\S+\\.tgz came from a service worker, not the network: close every tab of ${origin.replaceAll('.', '\\.')} and open seven again$`
    )
  );
  assert.deepEqual(bios.states().slice(0, 4), [
    'opfs:active',
    'opfs:done',
    'installer:active',
    'installer:done',
  ]);
  assert.match(
    await page.evaluate(() => document.querySelector('.diagnostics')?.textContent ?? ''),
    /boot \(under \/llm-proxy-sw\.js\)/
  );
  assert.deepEqual(await registered(page), []);
});

test('an old SLICC 6 worker that ignores the disarm message is unregistered before the installer starts, so seven downloads from npm and boots', async (t) => {
  state.proxy = 'old';
  const page = await open(t);
  await sixTab(page);
  const bios = await watch(page);
  await page.goto(`${origin}/7/`);
  await ready(page, undefined, { tools: false });
  assert.deepEqual(bios.states(), booted);
  assert.deepEqual(bios.texts('installer'), [
    "connection #1, SLICC 6's service worker unregistered",
  ]);
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    `${origin}/7/sw.js`
  );
  assert.deepEqual(await registered(page), [{ scope: '/', script: '/7/sw.js' }]);
});

test('a SLICC 6 worker that knows the disarm message stops answering for every client it controls, the installer a six tab started included, and seven boots', async (t) => {
  state.proxy = 'new';
  const holder = await open(t);
  await sixTab(holder);
  assert.equal((await probe(holder)).status, 404);
  assert.equal(await keepInstaller(holder), `${origin}/llm-proxy-sw.js`);

  const page = await holder.tab();
  const bios = await watch(page);
  await page.goto(`${origin}/7/`);
  await ready(page, undefined, { tools: false });
  assert.deepEqual(bios.states(), booted);
  assert.deepEqual(bios.texts('installer'), ["connection #2, SLICC 6's service worker disarmed"]);
  assert.match(bios.texts('packages').at(-1), /^\d+\/\d+ downloaded from npm/);

  const after = await probe(holder);
  assert.equal(after.type, 'cors');
  assert.equal(after.status, 200);
  assert.deepEqual(await registered(page), [{ scope: '/', script: '/7/sw.js' }]);
});

test('without SLICC 6 the installer step says nothing about it', async (t) => {
  const page = await open(t);
  const bios = await watch(page);
  await page.goto(`${origin}/7/`);
  await ready(page, undefined, { tools: false });
  assert.deepEqual(bios.texts('installer'), ['connection #1']);
});
