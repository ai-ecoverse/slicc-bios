import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AwsClient } from 'aws4fetch';
import { API, publishSeven, S3 } from '../../edge/publish.mjs';

const src = fileURLToPath(new URL('../../src/', import.meta.url));
const tree = (await readdir(src, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => relative(src, `${entry.parentPath}/${entry.name}`))
  .sort();

const TOKEN = 'dummy-deploy-token-value';
const ID = 'dummy-token-id';
const SECRET = createHash('sha256').update(TOKEN).digest('hex');

function cloudflare({
  manifest = { branch: 'main', files: ['old/gone.js', tree[0]] },
  verify = 'active',
  failPut,
} = {}) {
  const bucket = new Map([['seven/old/gone.js', 'old']]);
  if (manifest) bucket.set('seven.json', JSON.stringify(manifest));
  const requests = [];
  const resign = new AwsClient({
    accessKeyId: ID,
    secretAccessKey: SECRET,
    service: 's3',
    region: 'auto',
  });
  const fetcher = async (input, init = {}) => {
    const request = new Request(input, init);
    const body = request.method === 'PUT' ? Buffer.from(await request.arrayBuffer()) : undefined;
    requests.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
    });
    if (request.url === API) {
      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`)
        return Response.json({ success: false }, { status: 401 });
      return Response.json({ success: true, result: { id: ID, status: verify } });
    }
    assert.ok(request.url.startsWith(`${S3}/`), request.url);
    const datetime = request.headers.get('x-amz-date');
    const expected = await resign.sign(request.url, {
      method: request.method,
      body,
      aws: { datetime },
    });
    assert.equal(
      request.headers.get('authorization'),
      expected.headers.get('authorization'),
      `${request.method} ${request.url} is signed with the token's id and sha256`
    );
    const key = decodeURIComponent(request.url.slice(S3.length + 1));
    if (request.method === 'GET')
      return bucket.has(key) ? new Response(bucket.get(key)) : new Response('', { status: 404 });
    if (request.method === 'DELETE') {
      bucket.delete(key);
      return new Response(null, { status: 204 });
    }
    if (failPut?.(key)) return new Response('', { status: 500 });
    bucket.set(key, body.toString('latin1'));
    return new Response('', { status: 200 });
  };
  return { bucket, requests, fetcher };
}

test('a release publishes src/ to seven over R2’s S3 API, signed with the token’s id and sha256, deletes what the last release had and this one doesn’t, and never sends the token or the secret to R2', async () => {
  const r2 = cloudflare();
  assert.equal(
    await publishSeven({ token: TOKEN, fetcher: r2.fetcher, parallel: 3 }),
    'https://seven.sliccy.ai/'
  );
  const seven = [...r2.bucket.keys()]
    .filter((key) => key.startsWith('seven/'))
    .map((key) => key.slice('seven/'.length))
    .sort();
  assert.deepEqual(seven, tree);
  assert.deepEqual(JSON.parse(r2.bucket.get('seven.json')), { branch: 'main', files: tree });
  assert.equal(r2.requests.filter((request) => request.url === API).length, 1);
  for (const request of r2.requests.filter((request) => request.url !== API)) {
    const seen = `${request.url} ${JSON.stringify(request.headers)}`;
    assert.ok(!seen.includes(TOKEN) && !seen.includes(SECRET), `${request.method} ${request.url}`);
    assert.match(
      request.headers.authorization,
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${ID}/\\d{8}/auto/s3/aws4_request,`)
    );
  }
  assert.equal(r2.requests.at(-1).url, `${S3}/seven.json`);
});

test('a first release with no manifest yet publishes everything', async () => {
  const r2 = cloudflare({ manifest: null });
  await publishSeven({ token: TOKEN, fetcher: r2.fetcher });
  assert.deepEqual(JSON.parse(r2.bucket.get('seven.json')).files, tree);
});

test('seven isn’t published when its manifest names another branch, the token is missing, inactive or refused, or an upload fails, and the manifest then still lists the last release’s files', async () => {
  const other = cloudflare({ manifest: { branch: 'bb/x', files: [] } });
  await assert.rejects(
    publishSeven({ token: TOKEN, fetcher: other.fetcher }),
    /seven\.sliccy\.ai serves bb\/x, not main/
  );
  assert.equal(other.requests.filter((request) => request.method !== 'GET').length, 0);
  for (const [token, verify, error] of [
    [undefined, 'active', /no deploy token/],
    ['wrong-token', 'active', /doesn't verify: 401/],
    [TOKEN, 'disabled', /doesn't verify: 200/],
  ]) {
    const r2 = cloudflare({ verify });
    await assert.rejects(publishSeven({ token, fetcher: r2.fetcher }), error);
    assert.equal(r2.requests.filter((request) => request.url !== API).length, 0);
  }
  const broken = cloudflare({ failPut: (key) => key === `seven/${tree.at(-1)}` });
  await assert.rejects(
    publishSeven({ token: TOKEN, fetcher: broken.fetcher, parallel: 1 }),
    /PUT seven\/.+: 500/
  );
  assert.deepEqual(JSON.parse(broken.bucket.get('seven.json')).files, ['old/gone.js', tree[0]]);
  assert.ok(broken.bucket.has('seven/old/gone.js'));
});
