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
    const seen = JSON.parse(localStorage.getItem('test.seen') ?? '[]');
    localStorage.setItem('test.seen', JSON.stringify([...seen, location.href]));
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
    seen: JSON.parse(localStorage.getItem('test.seen') ?? '[]'),
    handoff: Object.keys(localStorage).filter((key) => key.startsWith('slicc-os.handoff.')),
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
  assert.deepEqual(where.handoff, []);
  assert.equal(new URLSearchParams(where.hash.slice(1)).has('handoff'), false, where.hash);
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
    window.close = () => {};
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
  const shown = await popup.evaluate(() => ({
    href: location.href,
    referrer: document.querySelector('meta[name="referrer"]')?.content ?? null,
    kept: 'sliccCallback' in globalThis,
  }));
  assert.equal(shown.href, `${origin}/auth/callback`);
  assert.equal(shown.referrer, 'no-referrer');
  assert.equal(shown.kept, false);
  const { entries } = await popup.send('Page.getNavigationHistory');
  for (const { url } of entries) assert.ok(!url.includes(secret), url);
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  for (const { url } of targetInfos) assert.ok(!url.includes(secret), url);
  assert.deepEqual(page.errors, []);
});

const handoffs = (page) =>
  page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('slicc-os.handoff.'))
  );

async function leftover(page) {
  await page.init(() => {
    if (localStorage.getItem('test.armed')) return;
    localStorage.setItem('test.armed', '1');
    localStorage.setItem(
      'slicc-os.handoff.stale',
      JSON.stringify({ at: Date.now() - 11 * 60 * 1000, values: { key: 'stale-key' } })
    );
  });
}

test('the handoff is cleared at the end of a boot that succeeds: its own entry, its id in the address, and an entry left from before', async (t) => {
  const page = await watched(t);
  await leftover(page);
  await page.goto('/#tailscale=off&users=enforce');
  await ready(page);
  await page.until(() => !location.hash.includes('handoff='));
  assert.deepEqual(await handoffs(page), []);
  const where = await addresses(page);
  assert.equal(where.hash, '#users=enforce');
  assert.ok(
    where.seen.some((url) => /\/os\/#users=enforce&handoff=[0-9a-f-]{36}$/.test(url)),
    `seven's UI got only the handoff's id: ${where.seen.join(' ')}`
  );
  assert.deepEqual(await idb(page, 'tailscale'), { enabled: false });
  assert.deepEqual(page.errors, []);
});

test('the handoff is cleared at the end of a boot whose UI fails to load, and of one whose BIOS step fails', async (t) => {
  const page = await watched(t);
  chrome.overrides.set('/seed/os.js', "throw new Error('the UI failed on purpose');\n");
  await page.goto(`/#${new URLSearchParams({ proxy: 'http://127.0.0.1:9', key: KEY })}`);
  await page.until(() => !!document.querySelector('main[data-refused]'));
  await page.until(() => !location.hash.includes('handoff='));
  assert.deepEqual(await handoffs(page), []);
  const where = await addresses(page);
  for (const url of [where.href, ...where.history, ...where.seen.slice(1)])
    assert.ok(!url.includes(KEY), url);

  const bios = await page.tab();
  chrome.overrides.set('/packages/package-lock.json', '{');
  await bios.goto(`/#${new URLSearchParams({ key: KEY })}`);
  await bios.until(
    () => document.querySelector('[data-step="packages"]')?.dataset.state === 'failed'
  );
  assert.deepEqual(await handoffs(bios), []);
  const href = await bios.evaluate(() => location.href);
  assert.ok(!href.includes(KEY) && !href.includes('handoff='), href);
});

test('when the settings from the link can’t be stored, the address is tidied anyway, nothing holds them, and the BIOS says in one line which it lost', async (t) => {
  const page = await watched(t);
  const proxy = await fakeProxy({ origin: new URL(chrome.url).origin, key: KEY });
  t.after(() => proxy.close());
  await page.init(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('slicc-os.handoff.'))
        throw new DOMException('storage is full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await page.goto(
    `/#${new URLSearchParams({ proxy: proxy.url, key: KEY, tailscale: 'off', exit: 'node-tidy', users: 'enforce' })}`
  );
  await page.until(
    () => document.querySelector('[data-step="navigate"]')?.dataset.state === 'failed'
  );
  const line = await page.evaluate(
    () => document.querySelector('[data-step="navigate"] output').value
  );
  assert.equal(
    line,
    'Seven couldn’t store the settings from the link (proxy, Tailscale). Allow site storage and open the link again.'
  );
  const where = await addresses(page);
  assert.equal(where.hash, '#users=enforce');
  for (const url of [where.href, ...where.history, ...where.targets, ...where.seen.slice(1)]) {
    assert.ok(!url.includes(KEY) && !url.includes('node-tidy'), url);
    assert.equal(new URL(url).pathname === '/os/', false, `the BIOS went on to ${url}`);
  }
  assert.deepEqual(where.handoff, []);
  assert.deepEqual(await page.evaluate(() => globalThis.sliccDropped), ['proxy', 'Tailscale']);
  assert.deepEqual(proxy.probes, []);
  assert.deepEqual(
    page.errors.filter((error) => !error.includes('couldn’t store')),
    []
  );
});

const PRODUCTION = [
  { name: 'content-security-policy', value: "frame-ancestors 'self'" },
  { name: 'x-frame-options', value: 'SAMEORIGIN' },
];

test('with the production headers on the boot page the tidying script runs, no policy blocks it, and /os/ and the callback have the same policy', async (t) => {
  const page = await watched(t);
  const origin = new URL(chrome.url).origin;
  await page.init(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const seen = JSON.parse(localStorage.getItem('test.violations') ?? '[]');
      localStorage.setItem(
        'test.violations',
        JSON.stringify([...seen, `${event.violatedDirective} ${event.blockedURI}`])
      );
    });
  });
  const served = [];
  const stop = chrome.cdp.on(async ({ method, params }) => {
    if (method !== 'Fetch.requestPaused' || new URL(params.request.url).pathname !== '/') return;
    const { body, base64Encoded } = await page.send('Fetch.getResponseBody', {
      requestId: params.requestId,
    });
    const kept = (params.responseHeaders ?? []).filter(
      ({ name }) => !PRODUCTION.some((header) => header.name === name.toLowerCase())
    );
    served.push(params.request.url);
    await page.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: params.responseStatusCode,
      responseHeaders: [...kept, ...PRODUCTION],
      body: base64Encoded ? body : Buffer.from(body).toString('base64'),
    });
  });
  t.after(() => stop?.());
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: `${origin}/`, resourceType: 'Document', requestStage: 'Response' }],
  });
  await page.goto(`/#${new URLSearchParams({ key: KEY, users: 'enforce' })}`);
  await ready(page);
  await page.send('Fetch.disable');
  assert.ok(served.length >= 1, 'the boot page came with the production headers');
  const where = await addresses(page);
  for (const url of [where.href, ...where.history, ...where.seen.slice(1)])
    assert.ok(!url.includes(KEY), url);
  assert.equal(where.hash, '#users=enforce');
  const policy = (url) =>
    page.responses
      .filter((response) => new URL(response.url).pathname === url)
      .map(
        (response) =>
          Object.entries(response.headers).find(
            ([name]) => name.toLowerCase() === 'content-security-policy'
          )?.[1]
      );
  assert.equal(policy('/')[0], "frame-ancestors 'self'", `the boot page: ${policy('/')}`);
  assert.equal(policy('/os/')[0], "frame-ancestors 'self'", `/os/: ${policy('/os/')}`);
  const callback = await page.evaluate(async () => {
    const response = await fetch('/auth/callback?nonce=n');
    return response.headers.get('content-security-policy');
  });
  assert.equal(callback, "frame-ancestors 'self'");
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test.violations') ?? '[]')),
    []
  );
  assert.deepEqual(page.errors, []);
});
