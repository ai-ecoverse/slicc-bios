import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { preview, publishBranch, ROUTE } from '../../edge/publish.mjs';

const src = fileURLToPath(new URL('../../src/', import.meta.url));
const tree = (await readdir(src, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => relative(src, `${entry.parentPath}/${entry.name}`))
  .sort();

function worker() {
  const bucket = { objects: new Set(['old/gone.js']), manifest: ['old/gone.js'] };
  let requests = 0;
  let cut = Number.POSITIVE_INFINITY;
  const fetcher = async (url, init = {}) => {
    requests += 1;
    if (requests > cut) throw new Error('the job was cancelled');
    const path = String(url).slice(`${ROUTE}/`.length);
    const method = init.method ?? 'GET';
    if (path === 'manifest' && method === 'GET') {
      return Response.json({ files: bucket.manifest });
    }
    if (path === 'manifest') {
      bucket.manifest = JSON.parse(init.body).files;
      return Response.json({ url: 'https://bb-x.sliccy.ai/' });
    }
    const file = decodeURIComponent(path.slice('files/'.length));
    if (method === 'DELETE') bucket.objects.delete(file);
    else bucket.objects.add(file);
    return Response.json({});
  };
  return {
    bucket,
    fetcher,
    cutAfter(n) {
      requests = 0;
      cut = n;
    },
  };
}

test('a preview publish cut off at any request leaves a manifest that lists every file the branch holds, so the next publish deletes what it no longer has', async () => {
  for (const n of [1, 2, 3, tree.length, tree.length + 2]) {
    const route = worker();
    route.cutAfter(n);
    await assert.rejects(
      publishBranch('bb/x', { fetcher: route.fetcher, token: 't', parallel: 1 })
    );
    const unlisted = [...route.bucket.objects].filter(
      (file) => !route.bucket.manifest.includes(file)
    );
    assert.deepEqual(unlisted, [], `cut after ${n} requests`);
    route.cutAfter(Number.POSITIVE_INFINITY);
    await publishBranch('bb/x', { fetcher: route.fetcher, token: 't', parallel: 1 });
    assert.deepEqual([...route.bucket.objects].sort(), tree, `after the cut at ${n}`);
    assert.deepEqual(route.bucket.manifest, tree, `after the cut at ${n}`);
  }
});

test('a pull request from a bb/** branch publishes its preview and gets its URL, another branch or a pull request without an OIDC token publishes nothing', async () => {
  const route = worker();
  let requests = 0;
  const fetcher = (...args) => {
    requests += 1;
    return route.fetcher(...args);
  };
  const oidc = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/' };
  for (const vars of [
    { ...oidc, GITHUB_HEAD_REF: 'renovate/x' },
    { ...oidc },
    { GITHUB_HEAD_REF: 'bb/x' },
  ]) {
    const result = await preview(vars, { fetcher, token: 't' });
    assert.equal(result.url, undefined, JSON.stringify(vars));
    assert.match(result.skipped, /gets no preview/);
  }
  assert.equal(requests, 0);
  assert.deepEqual(await preview({ ...oidc, GITHUB_HEAD_REF: 'bb/x' }, { fetcher, token: 't' }), {
    url: 'https://bb-x.sliccy.ai/',
  });
  assert.deepEqual([...route.bucket.objects].sort(), tree);
});
