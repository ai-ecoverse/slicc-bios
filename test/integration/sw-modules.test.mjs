import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, booted, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const source = (path) => readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const stubs = await source('sw/stubs.js');
const integrity = await source('sw/integrity.js');
const MISSING = 'is not available in the browser';
const WORKERS = ['/sw.js', '/sw.js?afresh'];
const AGENT = '/opt/agent/';

const probed = (n) => stubs.replace(MISSING, `${MISSING}, probe ${n}`);

const served = (page) =>
  page.evaluate(async () => {
    const stub = await (await fetch('/__slicc/node/fs.js')).text();
    const { pathname, search } = new URL(navigator.serviceWorker.controller.scriptURL);
    return { worker: `${pathname}${search}`, probe: stub.match(/probe \d+/)?.[0] ?? null };
  });

const watchers = new WeakMap();

async function watcher(page) {
  if (!watchers.has(page)) watchers.set(page, await watch(page));
  return watchers.get(page);
}

const settled = (page) =>
  page.within(
    5 * 60 * 1000,
    () => location.pathname !== '/os/' || document.querySelector('slicc-app')?.model.updates.ready()
  );

async function release(page, changes) {
  await settled(page);
  for (const [path, body] of Object.entries(changes)) chrome.overrides.set(path, body);
  const bios = await watcher(page);
  const from = bios.states().length;
  const mark = page.responses.length;
  await boot(page);
  const refused = page.responses
    .slice(mark)
    .filter((response) => response.status >= 400)
    .filter(
      (response) => response.status !== 404 || !new URL(response.url).pathname.startsWith(AGENT)
    )
    .map((response) => `${response.status} ${new URL(response.url).pathname}`);
  assert.deepEqual(refused, []);
  assert.deepEqual(bios.states().slice(from), booted);
  return served(page);
}

test('a release that changes only a module sw.js imports updates an installed seven, and so does the next one (#1022)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.deepEqual(await served(page), { worker: '/sw.js', probe: null });
  const workers = [];
  for (const n of [1, 2]) {
    const { worker, probe } = await release(page, { '/sw/stubs.js': probed(n) });
    assert.equal(probe, `probe ${n}`);
    assert.ok(WORKERS.includes(worker), worker);
    workers.push(worker);
  }
  t.diagnostic(`workers: ${workers.join(', ')}`);
  assert.deepEqual(await release(page, {}), { worker: workers.at(-1), probe: 'probe 2' });
  assert.deepEqual(page.errors, []);
});

test('a release that changes only the first module sw.js imports updates an installed seven (#1022)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const changed = await release(page, {
    '/sw/integrity.js': `${integrity}export const PROBE = 1;\n`,
    '/sw/stubs.js': probed(3),
  });
  assert.deepEqual(changed, { worker: '/sw.js', probe: 'probe 3' });
  assert.deepEqual(page.errors, []);
});

test('a module-only release whose worker throws fails the BIOS with the update’s error and keeps the installed worker (#1022)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  chrome.overrides.set('/sw/stubs.js', `${stubs}\nthrow new Error('probe: a broken worker');\n`);
  await page.goto('/');
  await page.within(
    120000,
    () => document.querySelector('[data-step="intercept"]')?.dataset.state === 'failed'
  );
  const shown = await page.evaluate(() => ({
    error: document.querySelector('[data-step="intercept"] output').value,
    worker: navigator.serviceWorker.controller?.scriptURL ?? null,
  }));
  t.diagnostic(shown.error);
  assert.match(shown.error, /update/i);
  assert.doesNotMatch(shown.error, /afresh/);
  assert.equal(new URL(shown.worker).pathname, '/sw.js');
  const registration = await page.evaluate(async () => {
    const found = await navigator.serviceWorker.getRegistration('/');
    return {
      active: found.active?.scriptURL ?? null,
      pending: (found.installing ?? found.waiting)?.scriptURL ?? null,
    };
  });
  assert.equal(new URL(registration.active).search, '');
  assert.equal(registration.pending, null);
  chrome.overrides.delete('/sw/stubs.js');
  assert.deepEqual(await release(page, {}), { worker: '/sw.js', probe: null });
});

test('a BIOS without the fresh install takes over a worker the fresh install registered, and this BIOS takes it back (#1022)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/sw.js?afresh', {
      type: 'module',
      scope: '/',
    });
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (worker.state === 'activated') return;
    await new Promise((resolve) =>
      worker.addEventListener('statechange', () => worker.state === 'activated' && resolve())
    );
  });
  assert.deepEqual(await release(page, {}), { worker: '/sw.js?afresh', probe: null });
  const older = [
    'export async function intercept(container, script, scope) {',
    "  const registration = await container.register(script, { type: 'module', scope });",
    '  if (!registration.installing && !registration.waiting) await registration.update();',
    '  return registration;',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(await release(page, { '/sw/register.js': older, '/sw/stubs.js': probed(4) }), {
    worker: '/sw.js',
    probe: 'probe 4',
  });
  chrome.overrides.delete('/sw/register.js');
  const { worker, probe } = await release(page, { '/sw/stubs.js': probed(5) });
  assert.equal(probe, 'probe 5');
  assert.ok(WORKERS.includes(worker), worker);
  assert.deepEqual(page.errors, []);
});

test('when the update and the fresh install both fail, as offline, the BIOS shows the update’s error and keeps the installed worker (#1022)', async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    if (location.pathname !== '/' || localStorage.getItem('probe.offline') !== '1') return;
    const register = ServiceWorkerContainer.prototype.register;
    ServiceWorkerRegistration.prototype.update = () =>
      Promise.reject(new TypeError('probe: the update found the network down'));
    ServiceWorkerContainer.prototype.register = async function (url, options) {
      const known = await this.getRegistration(options?.scope);
      if (known?.active?.scriptURL === new URL(url, location.href).href)
        return register.call(this, url, options);
      throw new TypeError('probe: the fresh install found the network down');
    };
  });
  await boot(page);
  await page.evaluate(() => localStorage.setItem('probe.offline', '1'));
  await page.goto('/');
  await page.within(
    120000,
    () => document.querySelector('[data-step="intercept"]')?.dataset.state === 'failed'
  );
  const shown = await page.evaluate(async () => {
    const found = await navigator.serviceWorker.getRegistration('/');
    return {
      error: document.querySelector('[data-step="intercept"] output').value,
      verb: document.querySelector('.verb')?.textContent ?? null,
      active: found.active?.scriptURL ?? null,
      pending: (found.installing ?? found.waiting)?.scriptURL ?? null,
    };
  });
  assert.equal(shown.error, 'probe: the update found the network down');
  assert.equal(new URL(shown.active).pathname + new URL(shown.active).search, '/sw.js');
  assert.equal(shown.pending, null);
  t.diagnostic(`splash: ${shown.verb}`);
  await page.evaluate(() => localStorage.removeItem('probe.offline'));
  assert.deepEqual(await release(page, {}), { worker: '/sw.js', probe: null });
});
