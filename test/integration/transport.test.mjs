import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';

const chrome = await launch();
const proxy = await fakeProxy({ origin: new URL(chrome.url).origin, key: 'the-key' });
after(async () => {
  await proxy.close();
  await chrome.close();
});

const transport = (page) => page.evaluate(() => document.documentElement.dataset.transport);
const fragment = (url, key) => `#${new URLSearchParams({ proxy: url, key })}`;
const stored = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('slicc-os');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('transport').objectStore('transport').get('proxy');
          get.onsuccess = () => {
            open.result.close();
            resolve(get.result ?? null);
          };
        };
      })
  );

test('a proxy in the fragment is probed, kept, stripped from the address bar and used', async (t) => {
  const page = await chrome.page(t);
  proxy.probes.length = 0;
  await page.goto(`/${fragment(proxy.url, 'the-key')}&keep=1`);
  await ready(page);

  assert.equal(await transport(page), 'local-proxy');
  assert.equal(
    await page.evaluate(() => location.href.replace(location.origin, '')),
    '/os/#keep=1'
  );
  assert.deepEqual(await stored(page), { url: proxy.url, key: 'the-key' });
  assert.deepEqual(proxy.probes, ['the-key']);

  await page.reload();
  await ready(page);
  assert.equal(await transport(page), 'local-proxy');
  assert.deepEqual(proxy.probes, ['the-key', 'the-key']);
  assert.deepEqual(page.errors, []);
});

test('a proxy that refuses its key is dropped, and the page falls back', async (t) => {
  const page = await chrome.page(t);
  proxy.probes.length = 0;
  await page.goto(`/${fragment(proxy.url, 'stale-key')}`);
  await ready(page);

  assert.equal(await transport(page), 'page');
  assert.deepEqual(proxy.probes, ['stale-key']);
  assert.equal(await stored(page), null);
  assert.equal(await page.evaluate(() => location.hash), '');
});

test('a proxy that is not on loopback is never contacted', async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/${fragment('https://evil.test', 'the-key')}`);
  await ready(page);

  assert.equal(await transport(page), 'page');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await stored(page), null);
});

test('without a proxy, the extension relay is used when it is there', async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    Object.defineProperty(globalThis, 'sliccExtension', {
      value: Object.freeze({ fetch: (input, init) => fetch(input, init) }),
    });
  });
  await page.goto('/');
  await ready(page);
  assert.equal(await transport(page), 'extension');
});

test('without either, the page fetch is used', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  assert.equal(await transport(page), 'page');
});
