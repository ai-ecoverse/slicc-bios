import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { type } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/server.mjs';
import { actPackage, boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const REMOTES = ['https://cdn.jsdelivr.net/', 'https://registry.npmjs.org/'];
const SLOW = /\/wasix-python-[^/]+\.tgz$/;
const CHUNK = 128 * 1024;
const PACE = 50;

const slow = createServer(async (request, response) => {
  const body = await download(decodeURIComponent(request.url.slice(1))).catch(() => null);
  if (!body) return response.writeHead(404).end();
  response.writeHead(200, {
    'access-control-allow-origin': '*',
    'content-type': 'application/gzip',
    'content-length': String(body.length),
  });
  for (let at = 0; at < body.length && !response.destroyed; at += CHUNK) {
    response.write(body.subarray(at, at + CHUNK));
    await new Promise((resolve) => setTimeout(resolve, PACE));
  }
  response.end();
});
await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
const port = slow.address().port;

const chrome = await launch({ timeout: 120000, intercept: [] });
after(() => {
  slow.close();
  return chrome.close();
});
chrome.cdp.on(async ({ method, params }) => {
  if (method !== 'Fetch.requestPaused') return;
  const { requestId, request } = params;
  if (SLOW.test(new URL(request.url).pathname))
    return chrome.cdp
      .send('Fetch.continueRequest', {
        requestId,
        url: `http://127.0.0.1:${port}/${encodeURIComponent(request.url)}`,
      })
      .catch(() => {});
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

test('a catalog install of one large package reports its download in bytes, summed from pnpm’s Downloading lines, and the bar shows them (#619)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const size = await page
    .within(300000, () => {
      const updates = document.querySelector('slicc-app').model.updates;
      const item = updates.packages().find((entry) => entry.id === 'python');
      window.sliccRow = item?.state ?? 'absent';
      if (item?.state !== 'available') return null;
      window.sliccSeen = [];
      window.sliccWatch = setInterval(() => {
        const row = updates.packages().find((entry) => entry.id === 'python');
        if (row?.progress) window.sliccSeen.push(row.progress);
        if (row?.log) window.sliccLog = row.log;
      }, 50);
      return item.size;
    })
    .catch(async (error) => {
      const seen = await page.evaluate(() => window.sliccRow);
      throw new Error(`the python row was never available, last ${seen}: ${error.message}`);
    });
  const installing = actPackage(page, 'python', 'install');
  const shown = await page
    .within(5 * 60 * 1000, () => {
      const row = document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((entry) => entry.id === 'python');
      const bytes = row?.progress?.bytes;
      return bytes && bytes.done > 0 && bytes.done < bytes.total / 2 ? bytes : null;
    })
    .catch(async (error) => {
      const log = await page.evaluate(() => window.sliccLog);
      throw new Error(`no bytes progress during the download: ${error.message}\n${log}`);
    });
  assert.ok(shown.total > 0);
  await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
  await shoot(page, 'python-download', { show: 'updates', target: 'li[data-id=python]' });
  assert.equal(await installing, 'ok');
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
