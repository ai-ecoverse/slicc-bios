import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { realVault } from './real-vault.mjs';

const PREVIEW = 'https://vault-preview.sliccy.ai';

test('real vault evidence records cold, cached and failed asset loads without their contents', async (t) => {
  const fetcher = globalThis.fetch;
  const asset = 'synthetic-content-excluded-from-evidence';
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.origin !== PREVIEW) return fetcher(input, options);
    if (url.pathname === '/config.json') return Response.json({ version: '1.21.1', embedders: [] });
    attempts += 1;
    return new Response(asset, {
      status: url.pathname === '/failed.js' ? 503 : 200,
      headers: { 'content-type': 'text/javascript' },
    });
  });
  const vault = await realVault('https://seven.example.test', { version: '1.21.1' });
  t.after(() => vault.close());
  for (const path of ['/frame.js', '/frame.js', '/failed.js']) {
    const response = await fetcher(new URL(path, vault.origin));
    await response.arrayBuffer();
    assert.equal(response.status, path === '/failed.js' ? 502 : 200);
  }
  assert.equal(attempts, 2);
  const evidence = vault.evidence();
  assert.equal(evidence.version, '1.21.1');
  assert.deepEqual(
    evidence.requests.map(({ status }) => status),
    [200, 200, 502]
  );
  assert.deepEqual(
    evidence.requests.map(({ cached }) => cached),
    [false, true, false]
  );
  assert.deepEqual(
    evidence.requests.map(({ upstreamStatus }) => upstreamStatus),
    [200, undefined, 503]
  );
  assert.equal(evidence.requests[2].error, 'Error');
  for (const request of evidence.requests) {
    assert.ok(request.startedAt <= request.finishedAt);
    assert.equal(request.aborted, false);
  }
  assert.equal(JSON.stringify(evidence).includes(asset), false);
  assert.deepEqual(
    evidence.assets.map(({ path }) => path),
    ['/frame.js']
  );
});

test('real vault warms a cold vault-preview before the version check', async (t) => {
  const fetcher = globalThis.fetch;
  let hits = 0;
  const stub = createServer((request, response) => {
    hits += 1;
    const reply = () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '1.21.1', embedders: [] }));
    };
    if (hits === 1) setTimeout(reply, 35000);
    else reply();
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const origin = `http://127.0.0.1:${stub.address().port}`;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.origin !== PREVIEW) return fetcher(input, options);
    return fetcher(new URL(url.pathname + url.search, origin), options);
  });
  const started = Date.now();
  const vault = await realVault('https://seven.example.test', { version: '1.21.1' });
  t.after(() => vault.close());
  assert.ok(Date.now() - started >= 35000);
  assert.ok(hits >= 2);
  assert.equal(vault.version, '1.21.1');
});

test('real vault retries config.json once after a cold-start timeout', async (t) => {
  const fetcher = globalThis.fetch;
  let configs = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.origin !== PREVIEW) return fetcher(input, options);
    if (url.pathname !== '/config.json') throw new Error(`unexpected ${url.pathname}`);
    configs += 1;
    if (configs <= 2)
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return Response.json({ version: '1.21.1', embedders: [] });
  });
  const vault = await realVault('https://seven.example.test', { version: '1.21.1' });
  t.after(() => vault.close());
  assert.equal(configs, 3);
  assert.equal(vault.version, '1.21.1');
});

test('real vault keeps the version mismatch error text', async (t) => {
  const fetcher = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.origin !== PREVIEW) return fetcher(input, options);
    return Response.json({ version: '9.9.9', embedders: [] });
  });
  await assert.rejects(() => realVault('https://seven.example.test', { version: '1.21.1' }), {
    message: 'the vault deployment version is 9.9.9, expected 1.21.1',
  });
});

test('real vault answers 504 when an upstream asset times out after one retry', async (t) => {
  const fetcher = globalThis.fetch;
  let assets = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.origin !== PREVIEW) return fetcher(input, options);
    if (url.pathname === '/config.json') return Response.json({ version: '1.21.1', embedders: [] });
    assets += 1;
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  const vault = await realVault('https://seven.example.test', { version: '1.21.1' });
  t.after(() => vault.close());
  const response = await fetcher(new URL('/cold.js', vault.origin));
  await response.arrayBuffer();
  assert.equal(response.status, 504);
  assert.equal(assets, 2);
  const [row] = vault.evidence().requests;
  assert.equal(row.status, 504);
  assert.equal(row.error, 'TimeoutError');
  assert.equal(row.aborted, true);
});

test('real vault recovers an upstream asset after one cold-start timeout', async (t) => {
  const fetcher = globalThis.fetch;
  const asset = 'recovered-after-timeout';
  let assets = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.origin !== PREVIEW) return fetcher(input, options);
    if (url.pathname === '/config.json') return Response.json({ version: '1.21.1', embedders: [] });
    assets += 1;
    if (assets === 1)
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(asset, { status: 200, headers: { 'content-type': 'text/javascript' } });
  });
  const vault = await realVault('https://seven.example.test', { version: '1.21.1' });
  t.after(() => vault.close());
  const response = await fetcher(new URL('/frame.js', vault.origin));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), asset);
  assert.equal(assets, 2);
  assert.equal(vault.evidence().requests[0].status, 200);
});
