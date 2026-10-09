import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';

const chrome = await launch();
const answer = async (request) =>
  request.url.startsWith('https://registry.npmjs.org/')
    ? {
        status: 200,
        headers: [['content-type', 'application/json']],
        body: await download(request.url),
      }
    : { status: 404, headers: [], body: Buffer.alloc(0) };
const proxy = await fakeProxy({ origin: new URL(chrome.url).origin, key: 'the-key', answer });
after(async () => {
  await proxy.close();
  await chrome.close();
});

const transport = (page) => page.evaluate(() => document.documentElement.dataset.transport);
const network = (page) =>
  page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    const { route, health, detail, failures } = app.model.network.status();
    const indicator = app.shadowRoot.querySelector('[data-network]')?.dataset.health ?? null;
    return { route, health, detail, failures, indicator };
  });
const shown = async (page) => {
  await page.until(
    () => !!document.querySelector('slicc-app').shadowRoot.querySelector('[data-network]')
  );
  const { failures, ...rest } = await network(page);
  return rest;
};
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
  assert.deepEqual(await shown(page), {
    route: 'proxy',
    health: 'ok',
    detail: `Local proxy at ${new URL(proxy.url).host}`,
    indicator: 'ok',
  });

  await page.reload();
  await ready(page);
  assert.equal(await transport(page), 'local-proxy');
  assert.deepEqual(proxy.probes, ['the-key', 'the-key']);
  assert.deepEqual(page.errors, []);
});

test('the proxy route turns red when the proxy stops answering, and lists the failure', async (t) => {
  const page = await chrome.page(t);
  const gone = await fakeProxy({ origin: new URL(chrome.url).origin, key: 'gone-key', answer });
  await page.goto(`/${fragment(gone.url, 'gone-key')}`);
  await ready(page);
  assert.equal((await shown(page)).health, 'ok');
  await gone.close();
  await run(page, 'curl -sS https://example.test/');
  await page.until(
    () =>
      document.querySelector('slicc-app').shadowRoot.querySelector('[data-network]')?.dataset
        .health === 'failing'
  );
  const status = await network(page);
  assert.equal(status.indicator, 'failing');
  assert.ok(status.failures.some((failure) => failure.url === 'https://example.test/'));
  await page.screenshot(new URL('failing.png', page.dir));
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
  const status = await shown(page);
  assert.deepEqual([status.route, status.health, status.indicator], ['page', 'limited', 'limited']);
  assert.match(
    status.detail,
    /refused this page \(proxy key missing or wrong\): open SLICC from the launcher again; using the page fetch/
  );
});

test('a proxy that is not running is named, and Retry switches to it once it is back', async (t) => {
  const page = await chrome.page(t);
  const later = await fakeProxy({ origin: new URL(chrome.url).origin, key: 'later-key' });
  const { port } = new URL(later.url);
  await later.close();
  await page.goto(`/${fragment(later.url, 'later-key')}`);
  await ready(page);

  assert.equal(await transport(page), 'page');
  assert.equal(
    (await shown(page)).detail,
    `No local proxy at 127.0.0.1:${port}: run npx @ai-ecoverse/slicc-node again; using the page fetch, limited by CORS`
  );

  const back = await fakeProxy({
    origin: new URL(chrome.url).origin,
    key: 'later-key',
    port: Number(port),
  });
  t.after(() => back.close());
  await page.evaluate(() =>
    document.querySelector('slicc-app').shadowRoot.querySelector('[data-network]').click()
  );
  const check = () =>
    document
      .querySelector('slicc-app')
      .dock.content('network')
      ?.shadowRoot?.querySelector('[data-action="check"]');
  await page.until(check);
  await page.screenshot(new URL('network-panel.png', page.dir));
  await page.evaluate(
    () =>
      void document
        .querySelector('slicc-app')
        .dock.content('network')
        .shadowRoot.querySelector('[data-action="check"]')
        .click()
  );
  await page.until(() => document.documentElement.dataset.transport === 'local-proxy');
  await ready(page);
  assert.deepEqual(await shown(page), {
    route: 'proxy',
    health: 'ok',
    detail: `Local proxy at 127.0.0.1:${port}`,
    indicator: 'ok',
  });
});

test('under the page fetch, the 502 curl shows points at slicc-node and slicc-extension', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  assert.deepEqual(await shown(page), {
    route: 'page',
    health: 'limited',
    detail: 'The page fetch, limited by CORS',
    indicator: 'limited',
  });
  await run(page, 'curl -sS https://unreachable.invalid/');
  await shows(
    page,
    'for the whole web, run npx @ai-ecoverse/slicc-node or install slicc-extension'
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .failures.some((failure) => failure.url.startsWith('https://unreachable.invalid/'))
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
  assert.deepEqual(await shown(page), {
    route: 'extension',
    health: 'ok',
    detail: 'Through slicc-extension',
    indicator: 'ok',
  });
});

test('without either, the page fetch is used', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  assert.equal(await transport(page), 'page');
});
