import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const edge = new URL('../../edge/', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', edge)));
const [{ binding }] = config.r2_buckets;

const worker = new Miniflare({
  modules: true,
  scriptPath: fileURLToPath(new URL(config.main, edge)),
  compatibilityDate: config.compatibility_date,
  r2Buckets: [binding],
});
after(() => worker.dispose());

const bucket = await worker.getR2Bucket(binding);
await bucket.put('seven/index.html', '<!doctype html><title>seven</title>');
await bucket.put('seven/bios.js', 'export {};');
await bucket.put('seven/packages/package-lock.json', '{}');
await bucket.put('seven.json', '["index.html"]');
await bucket.put('feat-shell/index.html', '<!doctype html><title>branch</title>');

const get = (url, init) => worker.dispatchFetch(url, init);

test('serves each host from its own prefix', async () => {
  const seven = await get('https://seven.sliccy.com/');
  assert.equal(seven.status, 200);
  assert.equal(seven.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(seven.headers.get('cache-control'), 'no-cache');
  assert.match(await seven.text(), /seven/);

  const branch = await get('https://feat-shell.sliccy.com/index.html');
  assert.match(await branch.text(), /branch/);
});

test('picks the content type from the extension', async () => {
  const types = await Promise.all(
    ['bios.js', 'packages/package-lock.json'].map(async (path) => {
      const response = await get(`https://seven.sliccy.com/${path}`);
      await response.arrayBuffer();
      return response.headers.get('content-type');
    })
  );
  assert.deepEqual(types, ['text/javascript; charset=utf-8', 'application/json']);
});

test('answers 404 for unknown hosts, files and manifests', async () => {
  for (const url of [
    'https://nobody.sliccy.com/',
    'https://seven.sliccy.com/missing.js',
    'https://feat-shell.sliccy.com/bios.js',
    'https://seven.sliccy.com/../seven.json',
  ]) {
    const response = await get(url);
    await response.arrayBuffer();
    assert.equal(response.status, 404, url);
  }
});

test('supports HEAD and conditional requests', async () => {
  const head = await get('https://seven.sliccy.com/bios.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const etag = head.headers.get('etag');
  const cached = await get('https://seven.sliccy.com/bios.js', {
    headers: { 'if-none-match': etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('etag'), etag);
});

test('rejects writes', async () => {
  const response = await get('https://seven.sliccy.com/', { method: 'POST', body: 'x' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});
