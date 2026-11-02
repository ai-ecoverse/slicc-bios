import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realVault } from './real-vault.mjs';

test('real vault evidence records cold, cached and failed asset loads without their contents', async (t) => {
  const fetcher = globalThis.fetch;
  const asset = 'synthetic-content-excluded-from-evidence';
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.origin !== 'https://vault-preview.sliccy.ai') return fetcher(input, options);
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
