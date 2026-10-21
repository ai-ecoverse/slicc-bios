import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { boot, ready } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';

const chrome = await launch();
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

const AWAY = 3000;
const LOST = 'BFCache exclusion lost: only the guard protects seven now';

function reasons(tree) {
  if (!tree) return [];
  return [
    ...(tree.explanations ?? []).map(({ reason }) => reason),
    ...(tree.children ?? []).flatMap(reasons),
  ];
}

test("Back to seven's /os/ from another page loads a fresh document, because Chrome reports seven's unload handler as a reason not to keep it in the back/forward cache", async (t) => {
  const page = await chrome.page(t);
  await boot(page);
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
  await page.until(() => document.getElementById('elsewhere'));
  await new Promise((done) => setTimeout(done, AWAY));
  await page.evaluate(() => setTimeout(() => history.back()));
  await page.until(() => location.pathname === '/os/' && !!document.querySelector('slicc-app'));
  const back = await page.evaluate(() => ({
    kept: window.sliccKept ?? null,
    type: performance.getEntriesByType('navigation')[0]?.type,
  }));
  const found = refused.flatMap(({ notRestoredExplanations = [], notRestoredExplanationsTree }) => [
    ...notRestoredExplanations.map(({ type, reason }) => `${type}:${reason}`),
    ...reasons(notRestoredExplanationsTree).map((reason) => `tree:${reason}`),
  ]);
  t.diagnostic(`back/forward cache refused seven's /os/: ${found.join(', ') || 'nothing'}`);
  assert.deepEqual(back, { kept: null, type: 'back_forward' }, LOST);
  assert.equal(refused.length, 1, LOST);
  assert.ok(
    refused[0].notRestoredExplanations?.some(
      ({ reason }) => reason === 'UnloadHandlerExistsInMainFrame'
    ),
    LOST
  );
  assert.deepEqual(page.errors, []);
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
