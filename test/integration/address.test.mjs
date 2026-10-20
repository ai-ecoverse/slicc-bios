import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';

const chrome = await launch();
after(() => chrome.close());

const KEY = 'tidy-key-0123456789abcdefghijklmn';
const TOKEN = 'Tidytoken0123456789xyz';
const FP = 'ab'.repeat(32);

async function watched(t) {
  const page = await chrome.page(t);
  await page.init(() => {
    const seen = JSON.parse(sessionStorage.getItem('test.seen') ?? '[]');
    sessionStorage.setItem('test.seen', JSON.stringify([...seen, location.href]));
  });
  return page;
}

async function addresses(page) {
  const { entries } = await page.send('Page.getNavigationHistory');
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const here = await page.evaluate(() => ({
    href: location.href,
    hash: location.hash,
    length: history.length,
    seen: JSON.parse(sessionStorage.getItem('test.seen') ?? '[]'),
    handoff: sessionStorage.getItem('slicc-os.handoff'),
  }));
  return {
    ...here,
    history: entries.map(({ url }) => url),
    targets: targetInfos.map(({ url }) => url),
  };
}

function clean(where, secrets, names) {
  const at = where.seen.findIndex((url) => new URL(url).pathname === '/os/');
  assert.ok(at > 0, `seven reached /os/: ${where.seen.join(' ')}`);
  const after = [where.href, ...where.history, ...where.targets, ...where.seen.slice(at)];
  for (const url of after) {
    for (const secret of secrets) assert.ok(!url.includes(secret), `${secret} in ${url}`);
    const params = new URLSearchParams(new URL(url, 'http://x').hash.slice(1));
    for (const name of names) assert.equal(params.has(name), false, `${name} in ${url}`);
  }
  assert.equal(where.handoff, null);
}

const network = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.network.status());

const idb = (page, key) =>
  page.evaluate(
    (key) =>
      new Promise((resolve, reject) => {
        const opening = indexedDB.open('slicc-os', 1);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const get = opening.result.transaction('transport').objectStore('transport').get(key);
          get.onsuccess = () => resolve(get.result ?? null);
          get.onerror = () => reject(get.error);
        };
      }),
    key
  );

test('a launch address with a proxy and its key is tidied before seven boots: no address, history entry or tab listing holds the key, and the proxy is used', async (t) => {
  const page = await watched(t);
  const proxy = await fakeProxy({ origin: new URL(chrome.url).origin, key: KEY });
  t.after(() => proxy.close());
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: KEY, users: 'enforce' })}`);
  await ready(page);
  await page.until(() => {
    const status = document.querySelector('slicc-app').model.network.status();
    return status.route === 'local-proxy' || status.route === 'proxy';
  });
  const where = await addresses(page);
  clean(where, [KEY, encodeURIComponent(proxy.url)], ['proxy', 'key']);
  assert.equal(where.hash, '#users=enforce');
  assert.ok(where.seen[0].includes(KEY), 'the launcher’s own address is the only one that held it');
  const status = await network(page);
  assert.equal(status.detail, `Local proxy at ${new URL(proxy.url).host}`, JSON.stringify(status));
  assert.deepEqual(await idb(page, 'proxy'), { url: proxy.url, key: KEY });
  assert.ok(proxy.probes.length > 0, 'seven checked the proxy with the key it was given');
  assert.deepEqual(page.errors, []);
});

test('a Tailscale setting in the address is tidied before seven boots, and the setting is kept', async (t) => {
  const page = await watched(t);
  await page.goto('/#tailscale=off&exit=node-tidy&users=enforce');
  await ready(page);
  await page.until(async () => {
    const opening = indexedDB.open('slicc-os', 1);
    const db = await new Promise((resolve) => {
      opening.onsuccess = () => resolve(opening.result);
    });
    const kept = await new Promise((resolve) => {
      const get = db.transaction('transport').objectStore('transport').get('tailscale');
      get.onsuccess = () => resolve(get.result ?? null);
    });
    db.close();
    return kept?.enabled === false;
  });
  const where = await addresses(page);
  clean(where, ['node-tidy'], ['tailscale', 'exit']);
  assert.equal(where.hash, '#users=enforce');
  assert.deepEqual(await idb(page, 'tailscale'), { enabled: false });
  assert.deepEqual(page.errors, []);
});

test('a pairing link in the address is tidied before seven boots, and seven still reads it', async (t) => {
  const page = await watched(t);
  await page.goto(`/#slicc-pair=9222.${TOKEN}.${FP}`);
  await ready(page);
  await page.until(
    () =>
      document.querySelector('slicc-app').model.network.status().links?.pairing?.state === 'failed'
  );
  const where = await addresses(page);
  clean(where, [TOKEN, FP], ['slicc-pair']);
  assert.equal(where.hash, '');
  assert.equal(
    (await network(page)).links.pairing.error,
    'Seven never pairs over port 9222: it’s a browser’s debugging port.'
  );
  assert.deepEqual(page.errors, []);
});

test('the sign-in callback tidies its address before its module loads, sends no referrer, and passes on only the nonce and the grant', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  await page.evaluate(() => {
    window.signIns = [];
    const channel = new BroadcastChannel('slicc-sign-in');
    channel.onmessage = ({ data }) => window.signIns.push(data);
  });
  const popup = await page.tab();
  await popup.init(() => {
    window.seenAt = location.href;
  });
  const secret = 'callback-token-0123456789';
  await popup.goto(
    `/auth/callback?nonce=n-tidy#access_token=${secret}&expires_in=60&token_type=bearer&scope=openid`
  );
  await page.until(() => window.signIns.length === 1);
  const [message] = await page.evaluate(() => window.signIns);
  const origin = new URL(chrome.url).origin;
  assert.deepEqual(message, {
    type: 'oauth-callback',
    nonce: 'n-tidy',
    redirectUrl: `${origin}/auth/callback?nonce=n-tidy#access_token=${secret}&expires_in=60`,
  });
  const shown = await popup
    .evaluate(() => ({
      href: location.href,
      referrer: document.querySelector('meta[name="referrer"]')?.content ?? null,
      kept: 'sliccCallback' in globalThis,
    }))
    .catch(() => null);
  if (shown) {
    assert.equal(shown.href, `${origin}/auth/callback`);
    assert.equal(shown.referrer, 'no-referrer');
    assert.equal(shown.kept, false);
    const { entries } = await popup.send('Page.getNavigationHistory');
    for (const { url } of entries) assert.ok(!url.includes(secret), url);
  }
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  for (const { url } of targetInfos) assert.ok(!url.includes(secret), url);
  assert.deepEqual(page.errors, []);
});
