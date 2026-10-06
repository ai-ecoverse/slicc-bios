import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';

const chrome = await launch();
const proxy = await fakeProxy({ origin: new URL(chrome.url).origin, key: 'the-key' });
after(async () => {
  await proxy.close();
  await chrome.close();
});

const transport = (page) => page.evaluate(() => document.documentElement.dataset.transport);
const notice = (page) =>
  page.evaluate(() => {
    const element = document.querySelector('.network');
    const [output, retry] = element.children;
    return {
      hidden: element.hidden,
      state: element.dataset.state,
      text: output.value,
      retry: !retry.hidden,
    };
  });
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
  assert.deepEqual(await notice(page), {
    hidden: false,
    state: 'ok',
    text: `network: local proxy at ${new URL(proxy.url).host}`,
    retry: false,
  });

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
  const shown = await notice(page);
  assert.equal(shown.state, 'failed');
  assert.match(
    shown.text,
    /refused this page \(proxy key missing or wrong\): open SLICC from the launcher again; using the page fetch/
  );
  assert.equal(shown.retry, false);
});

test('a proxy that is not running is named, and Retry switches to it once it is back', async (t) => {
  const page = await chrome.page(t);
  const later = await fakeProxy({ origin: new URL(chrome.url).origin, key: 'later-key' });
  const { port } = new URL(later.url);
  await later.close();
  await page.goto(`/${fragment(later.url, 'later-key')}`);
  await ready(page);

  assert.equal(await transport(page), 'page');
  const shown = await notice(page);
  assert.equal(
    shown.text,
    `no local proxy at 127.0.0.1:${port}: run npx @ai-ecoverse/slicc-node again; using the page fetch, limited by CORS`
  );
  assert.equal(shown.retry, true);

  const back = await fakeProxy({
    origin: new URL(chrome.url).origin,
    key: 'later-key',
    port: Number(port),
  });
  t.after(() => back.close());
  await page.evaluate(() => document.querySelector('.network button').click());
  await page.until(() => document.documentElement.dataset.transport === 'local-proxy');
  await ready(page);
  assert.equal((await notice(page)).text, `network: local proxy at 127.0.0.1:${port}`);
});

test('under the page fetch, the 502 curl shows points at slicc-node and slicc-extension', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  assert.equal(
    (await notice(page)).text,
    'network: the page fetch, limited by CORS (run npx @ai-ecoverse/slicc-node for the whole web)'
  );
  await run(page, 'curl -sS https://unreachable.invalid/');
  await shows(
    page,
    'for the whole web, run npx @ai-ecoverse/slicc-node or install slicc-extension'
  );
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
  assert.equal((await notice(page)).text, 'network: slicc-extension');
});

test('without either, the page fetch is used', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  assert.equal(await transport(page), 'page');
});
