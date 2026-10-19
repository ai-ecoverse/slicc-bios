import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { type } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/server.mjs';
import { actPackage, boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const REMOTES = ['https://cdn.jsdelivr.net/', 'https://registry.npmjs.org/'];
const chrome = await launch({ timeout: 120000, intercept: [] });
after(() => chrome.close());
chrome.cdp.on(async ({ method, params }) => {
  if (method !== 'Fetch.requestPaused') return;
  const { requestId, request } = params;
  const body = await download(request.url).catch(() => null);
  if (!body) return chrome.cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
  await chrome.cdp
    .send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'access-control-allow-origin', value: '*' },
        { name: 'content-type', value: type(new URL(request.url).pathname) },
        { name: 'content-length', value: String(body.length) },
      ],
      body: Buffer.from(body).toString('base64'),
    })
    .catch(() => {});
});
await chrome.cdp.send('Fetch.enable', {
  patterns: REMOTES.map((remote) => ({ urlPattern: `${remote}*` })),
});

test('a catalog install of one large package reports its download in bytes, summed from pnpm’s Downloading lines (#619)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const size = await page.within(300000, () => {
    const updates = document.querySelector('slicc-app').model.updates;
    const item = updates.packages().find((entry) => entry.id === 'python');
    if (item?.state !== 'available') return null;
    window.sliccSeen = [];
    window.sliccWatch = setInterval(() => {
      const row = updates.packages().find((entry) => entry.id === 'python');
      if (row?.progress) window.sliccSeen.push(row.progress);
      if (row?.log) window.sliccLog = row.log;
    }, 50);
    return item.size;
  });
  assert.equal(await actPackage(page, 'python', 'install'), 'ok');
  const seen = await page.evaluate(() => {
    clearInterval(window.sliccWatch);
    return window.sliccSeen;
  });
  const bytes = seen.filter((progress) => progress.bytes);
  assert.ok(bytes.length > 0, await page.evaluate(() => window.sliccLog));
  for (const { phase, bytes: got } of bytes) {
    assert.equal(phase, 'download');
    assert.ok(got.done <= got.total, JSON.stringify(got));
    assert.ok(Math.abs(got.total - size) < 10000, `${got.total} is not about ${size}`);
  }
  const done = bytes.map((progress) => progress.bytes.done);
  assert.deepEqual(
    done,
    [...done].sort((a, b) => a - b)
  );
  assert.deepEqual(page.errors, []);
});
