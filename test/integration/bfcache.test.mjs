import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
const away = createServer((request, response) => {
  response
    .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end('<!doctype html><title>elsewhere</title><p id="elsewhere">elsewhere</p>\n');
});
await new Promise((done) => away.listen(0, '127.0.0.1', done));
const elsewhere = `http://localhost:${away.address().port}/`;
after(async () => {
  await new Promise((done) => {
    away.close(done);
    away.closeAllConnections();
  });
  await chrome.close();
});

const LAG = 3000;
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
  await new Promise((done) => setTimeout(done, LAG));
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
