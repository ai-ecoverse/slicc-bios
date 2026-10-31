import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
const asked = [];
const named = createServer((req, res) => {
  asked.push(`${req.method} ${req.url}`);
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
  res.end('{}');
});
await new Promise((resolve) => named.listen(0, '127.0.0.1', resolve));
const NAMED = `http://127.0.0.1:${named.address().port}`;
after(async () => {
  named.close();
  named.closeAllConnections();
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

const keys = (page) =>
  page.evaluate(async () => {
    const local = Object.entries(localStorage).flat();
    const databases = (await indexedDB.databases()).map((db) => db.name);
    return { local, databases, address: location.href };
  });

test('a #proxy= and key= fragment is stripped before anything loads and never honoured: no request to the named port, no local-proxy transport, and the key is nowhere', async (t) => {
  const page = await chrome.page(t);
  const MARK = `MARK${randomBytes(8).toString('hex')}`;
  asked.length = 0;
  await page.goto(`/#${new URLSearchParams({ proxy: NAMED, key: MARK })}&keep=1`);
  await ready(page);
  assert.equal(await transport(page), 'page');
  assert.equal(
    await page.evaluate(() => location.href.replace(location.origin, '')),
    '/os/#keep=1'
  );
  assert.equal(await stored(page), null);
  await run(page, 'curl -sS https://unreachable.invalid/ > /dev/null 2>&1; echo "fetched-""done"');
  await shows(page, 'fetched-done');
  const seen = await keys(page);
  assert.ok(
    !JSON.stringify(seen).includes(MARK),
    `the key is held somewhere: ${JSON.stringify(seen)}`
  );
  assert.ok(!page.console.some((line) => line.includes(MARK)), 'the key reached the console');
  const status = await shown(page);
  assert.deepEqual([status.route, status.health, status.detail], ['page', 'limited', null]);
  assert.deepEqual(asked, [], 'seven contacted the port the fragment named');
  assert.deepEqual(page.errors, []);
});

test('a proxy an older seven kept in IndexedDB is deleted at boot and never contacted', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  const MARK = `MARK${randomBytes(8).toString('hex')}`;
  await page.evaluate(
    ([url, key]) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('slicc-os');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const put = open.result
            .transaction('transport', 'readwrite')
            .objectStore('transport')
            .put({ url, key }, 'proxy');
          put.onsuccess = () => {
            open.result.close();
            resolve();
          };
          put.onerror = () => reject(put.error);
        };
      }),
    [NAMED, MARK]
  );
  assert.deepEqual(await stored(page), { url: NAMED, key: MARK });
  asked.length = 0;
  await page.reload();
  await ready(page);
  assert.equal(await transport(page), 'page');
  assert.equal(await stored(page), null);
  assert.deepEqual(asked, [], 'seven contacted a proxy an older seven kept');
  assert.deepEqual(page.errors, []);
});

test('the extension route turns red when slicc-extension stops answering, and lists the failure', async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    Object.defineProperty(globalThis, 'sliccExtension', {
      value: Object.freeze({
        fetch: (input, init) =>
          window.extensionDown
            ? Promise.reject(new TypeError('Failed to fetch'))
            : fetch(input, init),
      }),
    });
  });
  await page.goto('/');
  await ready(page);
  assert.equal((await shown(page)).health, 'ok');
  await page.evaluate(() => {
    window.extensionDown = true;
  });
  await run(page, 'curl -sS https://example.test/');
  await page.until(
    () =>
      document.querySelector('slicc-app').shadowRoot.querySelector('[data-network]')?.dataset
        .health === 'failing'
  );
  const status = await network(page);
  assert.equal(status.indicator, 'failing');
  assert.equal(
    status.detail,
    'slicc-extension stopped answering: check that it is still installed and enabled'
  );
  assert.ok(status.failures.some((failure) => failure.url === 'https://example.test/'));
  await page.screenshot(new URL('failing.png', page.dir));
});

test('under the page fetch, the 502 curl shows points at the slicc CLI and slicc-extension', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  assert.deepEqual(await shown(page), {
    route: 'page',
    health: 'limited',
    detail: null,
    indicator: 'limited',
  });
  await run(page, 'curl -sS https://unreachable.invalid/');
  await shows(page, 'for the whole web, run npx sliccy@next');
  await shows(page, 'install slicc-extension');
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.network.status()
      .failures.some((failure) => failure.url.startsWith('https://unreachable.invalid/'))
  );
});

test('the extension relay is used when it is there', async (t) => {
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
    detail: null,
    indicator: 'ok',
  });
});

test('the page fetch never names a User-Agent, which WebKit would preflight and npm refuses', async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    const send = globalThis.fetch.bind(globalThis);
    globalThis.fetchAgents = [];
    globalThis.fetch = (input, init) => {
      if (String(input).includes('/agent-probe'))
        globalThis.fetchAgents.push(new Headers(init?.headers).get('user-agent'));
      return send(input, init);
    };
  });
  await page.goto('/');
  await ready(page);
  await run(page, `curl -s -A probe-agent ${NAMED}/agent-probe >/dev/null; echo asked-$?`);
  await shows(page, 'asked-0');
  assert.deepEqual(await page.evaluate(() => globalThis.fetchAgents), [null]);
  assert.ok(asked.includes('GET /agent-probe'));
});

test('without either, the page fetch is used', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  assert.equal(await transport(page), 'page');
});
