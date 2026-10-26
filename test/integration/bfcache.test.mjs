import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';

const chrome = await launch({ tools: false });
const seven = new URL(chrome.url);
const www = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://www');
  if (url.pathname === '/7/index.html') return response.writeHead(302, { location: '/7/' }).end();
  if (url.pathname.startsWith('/7/') || url.pathname.startsWith('/fonts/')) {
    const path = url.pathname.startsWith('/7/') ? url.pathname.slice(2) : url.pathname;
    const upstream = await fetch(new URL(`${path}${url.search}`, seven));
    const headers = Object.fromEntries(
      [...upstream.headers].filter(
        ([name]) => !['content-encoding', 'transfer-encoding'].includes(name)
      )
    );
    if (url.pathname === '/7/sw.js') headers['service-worker-allowed'] = '/';
    return response
      .writeHead(upstream.status, headers)
      .end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (url.pathname.startsWith('/os/')) {
    return request.headers['sec-fetch-mode'] === 'navigate'
      ? response.writeHead(302, { location: '/7/' }).end()
      : response.writeHead(404).end();
  }
  response.writeHead(404).end();
});
await new Promise((done) => www.listen(0, '127.0.0.1', done));
const shared = `http://127.0.0.1:${www.address().port}`;
const away = createServer((request, response) => {
  response
    .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end('<!doctype html><title>elsewhere</title><p id="elsewhere">elsewhere</p>\n');
});
await new Promise((done) => away.listen(0, '127.0.0.1', done));
const elsewhere = `http://localhost:${away.address().port}/`;
after(async () => {
  for (const server of [away, www]) {
    await new Promise((done) => {
      server.close(done);
      server.closeAllConnections();
    });
  }
  await chrome.close();
});

const LOST = 'BFCache exclusion lost: only the guard protects seven now';

function reasons(tree) {
  if (!tree) return [];
  return [
    ...(tree.explanations ?? []).map(({ reason }) => reason),
    ...(tree.children ?? []).flatMap(reasons),
  ];
}

async function comeBack(t, page, landed, label) {
  const { frameTree } = await page.send('Page.getFrameTree');
  const frame = frameTree.frame.id;
  const refused = [];
  const off = chrome.cdp.on(({ method, params }) => {
    if (method === 'Page.backForwardCacheNotUsed' && params.frameId === frame) refused.push(params);
  });
  t.after(off);
  await page.evaluate(() => {
    window.sliccKept = 'kept';
  });
  await page.goto(elsewhere);
  await page.until(
    () => !!document.getElementById('elsewhere') && document.readyState === 'complete'
  );
  await page.evaluate(() => setTimeout(() => history.back()));
  await page.until(landed);
  const back = await page.evaluate(() => ({
    kept: window.sliccKept ?? null,
    type: performance.getEntriesByType('navigation')[0]?.type,
  }));
  const found = refused.flatMap(({ notRestoredExplanations = [], notRestoredExplanationsTree }) => [
    ...notRestoredExplanations.map(({ type, reason }) => `${type}:${reason}`),
    ...reasons(notRestoredExplanationsTree).map((reason) => `tree:${reason}`),
  ]);
  t.diagnostic(`back/forward cache refused seven's ${label}: ${found.join(', ') || 'nothing'}`);
  assert.deepEqual(back, { kept: null, type: 'back_forward' }, LOST);
  assert.equal(refused.length, 1, LOST);
  assert.ok(
    refused[0].notRestoredExplanations?.some(
      ({ reason }) => reason === 'UnloadHandlerExistsInMainFrame'
    ),
    LOST
  );
}

test("Back to seven's /os/, its guest page and the BIOS page from another page loads each fresh, because Chrome reports seven's unload handler as a reason not to keep them in the back/forward cache", async (t) => {
  const page = await chrome.page(t);
  await page.init(() => {
    if (location.pathname === '/' && sessionStorage.getItem('test.hold-bios'))
      globalThis.sliccDropped = ['proxy'];
  });
  await boot(page);
  await comeBack(
    t,
    page,
    () => location.pathname === '/os/' && !!document.querySelector('slicc-app'),
    '/os/'
  );

  await page.goto('/os/join.html');
  await page.until(
    () => location.pathname === '/os/join.html' && document.body.textContent.length > 0
  );
  await comeBack(
    t,
    page,
    () => location.pathname === '/os/join.html' && document.body.textContent.length > 0,
    'guest page'
  );

  await page.evaluate(() => sessionStorage.setItem('test.hold-bios', '1'));
  await page.goto('/');
  const halted = () =>
    location.pathname === '/' &&
    !!navigator.serviceWorker.controller &&
    document.querySelector('[data-step="navigate"]')?.dataset.state === 'failed';
  await page.until(halted);
  await comeBack(t, page, halted, 'BIOS page');
  const held = /^Error: Seven couldn’t store the settings from the link \(proxy\)/;
  assert.deepEqual(
    page.errors.filter((error) => !held.test(error)),
    []
  );
});

test("a navigation to a BIOS path that the host redirects still follows the redirect under seven's service worker", async (t) => {
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(shared)} && !localStorage.getItem(${JSON.stringify(VAULT_KEY)})) localStorage.setItem(${JSON.stringify(VAULT_KEY)}, ${JSON.stringify(chrome.vault.origin)}); }`
  );
  await page.goto(`${shared}/7/`);
  await ready(page);
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    `${shared}/7/sw.js`
  );
  await page.goto(`${shared}/7/index.html`);
  await ready(page);
  assert.equal(await page.evaluate(() => location.href), `${shared}/os/`);
  assert.deepEqual(page.errors, []);
});

test("a sandboxed HTML file from OPFS is sent no-store with unload allowed, like seven's own pages", async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const sandboxed = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const home = await root.getDirectoryHandle('home', { create: true });
    const writable = await (
      await home.getFileHandle('kept-page.html', { create: true })
    ).createWritable();
    await writable.write('<!doctype html><title>kept</title>');
    await writable.close();
    const response = await fetch('/home/kept-page.html', { cache: 'no-store' });
    return {
      status: response.status,
      sandbox: /sandbox/.test(response.headers.get('content-security-policy') ?? ''),
      cache: response.headers.get('cache-control'),
      unload: response.headers.get('permissions-policy'),
    };
  });
  assert.deepEqual(
    sandboxed,
    { status: 200, sandbox: true, cache: 'no-store', unload: 'unload=(self)' },
    LOST
  );
  assert.deepEqual(page.errors, []);
});
