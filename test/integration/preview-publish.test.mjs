import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { env, execPath } from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

test('a preview the route refuses or can’t reach reports why and sets no URL, so the pull request’s CI goes on', async () => {
  const refused = async () => Response.json({ error: 'not a branch' }, { status: 403 });
  const down = async () => {
    throw new Error('fetch failed');
  };
  const vars = {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/',
    GITHUB_HEAD_REF: 'bb/x',
  };
  assert.deepEqual(await preview(vars, { fetcher: refused, token: 'route-token-1' }), {
    skipped: 'preview failed: manifest: 403 not a branch',
  });
  assert.deepEqual(await preview(vars, { fetcher: down, token: 'route-token-1' }), {
    skipped: 'preview failed: fetch failed',
  });
});

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../edge/publish.mjs', import.meta.url));
const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOmJiL3gifQ.c2lnbmF0dXJl';

async function tokens(t) {
  const server = createServer((request, response) => {
    if (request.url.startsWith('/fail')) response.writeHead(500).end();
    else if (request.url.startsWith('/jwt')) response.writeHead(200).end(jwt);
    else if (request.url.startsWith('/lines')) response.writeHead(200).end('%\r\n::error::x');
    else response.writeHead(200).end(request.headers.authorization.slice('Bearer '.length));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function deploy(t, vars) {
  const dir = await mkdtemp(join(tmpdir(), 'preview-publish-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'output');
  await writeFile(output, '');
  const { stdout, stderr } = await exec(execPath, [cli, 'preview'], {
    env: { PATH: env.PATH, GITHUB_OUTPUT: output, ...vars },
  });
  return { stdout, stderr, output: await readFile(output, 'utf8') };
}

test('a pull request that gets no preview says why in the job log as a warning, as well as in the step summary, and sets no URL', async (t) => {
  const base = await tokens(t);
  for (const [vars, reason] of [
    [{ GITHUB_HEAD_REF: 'renovate/x' }, 'renovate/x gets no preview, only bb/** branches do'],
    [{}, 'this run gets no preview, only bb/** branches do'],
    [{ GITHUB_HEAD_REF: 'bb/x' }, 'bb/x has no OIDC token, so it gets no preview'],
    [
      {
        GITHUB_HEAD_REF: 'bb/x',
        ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/fail`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret-1',
      },
      "preview failed: GitHub's OIDC token: 500",
    ],
  ]) {
    const run = await deploy(t, vars);
    assert.deepEqual(run, {
      stdout: `${reason}\n`,
      stderr: `::warning title=preview::${reason}\n`,
      output: '',
    });
  }
});

test('a failed preview says why in the job log without printing the OIDC request token or an OIDC token', async (t) => {
  const base = await tokens(t);
  for (const path of ['echo', 'jwt']) {
    const run = await deploy(t, {
      GITHUB_HEAD_REF: 'bb/x',
      ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/${path}`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret-1',
    });
    assert.match(run.stdout, /^preview failed: .*\*\*\*.*\n$/, path);
    assert.equal(run.stderr, `::warning title=preview::${run.stdout}`, path);
    assert.equal(run.output, '', path);
    assert.doesNotMatch(run.stdout + run.stderr, /request-secret|eyJ/, path);
  }
});

test('a reason with line breaks stays one warning in the job log, so it starts no workflow command of its own', async (t) => {
  const base = await tokens(t);
  const run = await deploy(t, {
    GITHUB_HEAD_REF: 'bb/x',
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/lines`,
  });
  assert.match(run.stdout, /^preview failed: .*%\r\n::error::x/);
  assert.match(run.stderr, /^::warning title=preview::[^\r\n]*%25%0D%0A::error::x[^\r\n]*\n$/);
  assert.equal(run.output, '');
});

test('a preview the route refuses with the token it was sent reports why without the token', async (t) => {
  const before = {
    url: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    token: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  t.after(() => {
    for (const [key, value] of [
      ['ACTIONS_ID_TOKEN_REQUEST_URL', before.url],
      ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', before.token],
    ]) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });
  env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.actions.example/';
  env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'request-secret-1';
  const vars = {
    ACTIONS_ID_TOKEN_REQUEST_URL: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    GITHUB_HEAD_REF: 'bb/x',
  };
  const refuse = async (_url, init) => {
    throw new Error(`refused ${init.headers.authorization}`);
  };
  const issue = async (url, init) =>
    String(url).startsWith(env.ACTIONS_ID_TOKEN_REQUEST_URL)
      ? Response.json({ value: jwt })
      : refuse(url, init);
  for (const [fetcher, token] of [
    [issue, 'route-token-1'],
    [issue, undefined],
    [refuse, undefined],
  ]) {
    assert.deepEqual(await preview(vars, { fetcher, token }), {
      skipped: 'preview failed: refused Bearer ***',
    });
  }
});
