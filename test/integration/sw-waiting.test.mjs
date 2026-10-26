import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
const SIZE = 64 * 1024 * 1024;
let bump = 0;

const deep = (selector) => {
  const walk = (root) => {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const element of root.querySelectorAll('*')) {
      const inner = element.shadowRoot && walk(element.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  return walk(document);
};

const INSTALL = "self.addEventListener('install', () => self.skipWaiting());";

function waitingWorker() {
  assert.ok(current.includes(INSTALL));
  bump += 1;
  chrome.overrides.set(
    '/sw.js',
    current
      .replace(INSTALL, "self.addEventListener('install', () => {});")
      .replace('const own = ', `const own =${' '.repeat(bump)} `)
  );
}

function bumpWorker() {
  bump += 1;
  chrome.overrides.set(
    '/sw.js',
    current.replace('const own = ', `const own =${' '.repeat(bump)} `)
  );
}

const settled = (page) =>
  page.within(5 * 60 * 1000, () => document.querySelector('slicc-app').model.updates.ready());

const hold = (page) =>
  page.evaluate(async () => {
    const reader = (await fetch('/os/held.bin?token=<b>s3cret</b>#frag')).body.getReader();
    await reader.read();
    window.heldReader = reader;
  });

const update = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
    return (registration.installing ?? registration.waiting)?.state ?? null;
  });

const waitingNotice = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((notice) => notice.id.startsWith('sw-waiting:'))
  );

const workers = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      active: registration.active?.state ?? null,
      waiting: registration.waiting?.state ?? null,
      installing: registration.installing?.state ?? null,
    };
  });

test('while the tab holds a half-read download from the old worker, it says seven updated and names the download, and Reload reloads the tab (#710)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  await hold(page);
  bumpWorker();
  assert.ok(await update(page));
  const notice = await page.within(30000, () =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((notice) => notice.id.startsWith('sw-waiting:'))
  );
  assert.deepEqual(
    { title: notice.title, body: notice.body, actions: notice.actions },
    {
      title: 'Seven updated',
      body: 'This tab is still loading /os/held.bin with the old version. Reload to apply the update; that load stops.',
      actions: [{ id: 'reload', label: 'Reload' }],
    }
  );
  assert.deepEqual(await workers(page), {
    active: 'activated',
    waiting: 'installed',
    installing: null,
  });
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await page.within(30000, new Function(`return !!(${deep})('[data-notice^="sw-waiting:"]')`));
  assert.deepEqual(
    await page.evaluate(
      new Function(
        `const p = (${deep})('[data-notice^="sw-waiting:"] p'); return [p.textContent, p.children.length];`
      )
    ),
    [notice.body, 0],
    'the notice names the stream by its path as plain text, without its query or fragment'
  );
  await shoot(page, 'sw-waiting', { show: 'chat', target: '[data-notice^="sw-waiting:"]' });
  await page.evaluate(
    new Function(`(${deep})('[data-notice^="sw-waiting:"] [data-action="reload"]').click()`)
  );
  await page.until(() => !window.heldReader && location.pathname === '/os/');
  assert.deepEqual(page.errors, []);
});

test('when another seven tab holds the download, the owner names that tab instead, and it stops naming that tab once the tab closes (#710)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  const second = await page.tab();
  await boot(second);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  await hold(second);
  bumpWorker();
  assert.ok(await update(page));
  const notice = await page.within(30000, () =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((notice) => notice.id.startsWith('sw-waiting:') && notice.body.startsWith('Another'))
  );
  assert.deepEqual(
    { body: notice.body, actions: notice.actions },
    {
      body: 'Another seven tab is still loading /os/held.bin with the old version. Close or reload that tab to apply the update.',
      actions: [],
    }
  );
  assert.equal(
    await second.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.notices.list()
        .some((notice) => notice.id.startsWith('sw-waiting:'))
    ),
    false
  );
  assert.deepEqual(second.errors, []);
  await second.close();
  await page.within(15000, async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const notice = document
      .querySelector('slicc-app')
      .model.notices.list()
      .find((notice) => notice.id.startsWith('sw-waiting:'));
    return !registration.waiting || notice?.body === 'Reload to apply the update.';
  });
  assert.deepEqual(page.errors, []);
});

test('an ordinary update shows no notice: the updated worker activates before any notice could show, and nothing said seven updated (#710)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  await page.evaluate(() => {
    window.noticed = [];
    document
      .querySelector('slicc-app')
      .model.notices.on('notices', (list) => window.noticed.push(...list.map(({ id }) => id)));
  });
  bumpWorker();
  assert.ok(await update(page));
  await page.within(30000, async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return !registration.waiting && !registration.installing;
  });
  assert.deepEqual(
    await page.evaluate(() => window.noticed.filter((id) => id.startsWith('sw-waiting:'))),
    []
  );
  assert.deepEqual(page.errors, []);
});

test('an update activates within 15 s while the tab keeps pulling a long download from the old worker: the old worker ends the download with an error once it is 5 s old, before any notice could show, and the next fetch of it comes whole from the new worker (#710)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  await page.evaluate(async () => {
    window.noticed = [];
    document
      .querySelector('slicc-app')
      .model.notices.on('notices', (list) => window.noticed.push(...list.map(({ id }) => id)));
    window.switched = null;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.switched = performance.now();
    });
    const reader = (await fetch('/os/held.bin')).body.getReader();
    window.pulled = { bytes: 0, end: null };
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            window.pulled.end = 'done';
            return;
          }
          window.pulled.bytes += value.byteLength;
          await new Promise((resolve) => setTimeout(resolve, value.byteLength / 2048));
        }
      } catch (error) {
        window.pulled.end = error.name;
      }
    })();
  });
  await page.within(5000, () => window.pulled.bytes > 0);
  bumpWorker();
  const started = await page.evaluate(() => performance.now());
  assert.ok(await update(page));
  const took = await page.within(
    15000,
    async (started) => {
      const registration = await navigator.serviceWorker.getRegistration();
      return (
        !registration.waiting &&
        !registration.installing &&
        window.switched !== null &&
        Math.round(window.switched - started)
      );
    },
    started
  );
  t.diagnostic(`the update took over ${took} ms after the update check`);
  assert.deepEqual(await workers(page), { active: 'activated', waiting: null, installing: null });
  const pulled = await page.within(10000, () => window.pulled.end && window.pulled);
  assert.notEqual(pulled.end, 'done', 'the download fails instead of ending early');
  assert.ok(pulled.bytes < SIZE, JSON.stringify(pulled));
  const again = await page.evaluate(async () => {
    const response = await fetch('/os/held.bin', { cache: 'no-store' });
    return (await response.arrayBuffer()).byteLength;
  });
  assert.equal(again, SIZE);
  assert.deepEqual(
    await page.evaluate(() => window.noticed.filter((id) => id.startsWith('sw-waiting:'))),
    []
  );
  assert.deepEqual(page.errors, []);
});

test('an update that waits without skipping waiting on its own is activated by seven’s nudge before any notice could show (#959)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  await page.evaluate(() => {
    window.noticed = [];
    document
      .querySelector('slicc-app')
      .model.notices.on('notices', (list) => window.noticed.push(...list.map(({ id }) => id)));
  });
  waitingWorker();
  assert.ok(await update(page));
  await page.within(9000, async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return (
      registration.active?.state === 'activated' &&
      !registration.waiting &&
      !registration.installing
    );
  });
  assert.deepEqual(await workers(page), { active: 'activated', waiting: null, installing: null });
  assert.deepEqual(
    await page.evaluate(() => window.noticed.filter((id) => id.startsWith('sw-waiting:'))),
    []
  );
  assert.deepEqual(page.errors, []);
});

test('the BIOS nudges an update that waits without skipping waiting, and boots onto it instead of going on under the old worker (#959)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  waitingWorker();
  await page.goto('/');
  await ready(page);
  assert.deepEqual(await workers(page), { active: 'activated', waiting: null, installing: null });
  assert.deepEqual(
    page.console.filter((line) => line.includes('going on under the active worker')),
    []
  );
  assert.deepEqual(page.errors, []);
});
