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
import { label, preview, publishBranch, ROUTE } from '../../edge/publish.mjs';
import {
  checkout,
  DEPLOY,
  GATE,
  OFF,
  ON,
  races,
  refusals,
  tree as scratch,
  step,
  strays,
  swapping,
  unnamed,
} from './publish-tree.mjs';

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

function actions(t) {
  const before = {
    url: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    token: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  t.after(() => {
    for (const [name, value] of [
      ['ACTIONS_ID_TOKEN_REQUEST_URL', before.url],
      ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', before.token],
    ]) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  });
  env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.actions.example/';
  env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'request-secret-1';
  return {
    ACTIONS_ID_TOKEN_REQUEST_URL: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    GITHUB_HEAD_REF: 'bb/x',
  };
}

function recorded(route) {
  const sent = [];
  const fetcher = (url, init = {}) => {
    sent.push({
      method: init.method ?? 'GET',
      url: String(url),
      authorization: init.headers?.authorization,
      length: init.headers?.['content-length'],
      body: init.body === undefined ? undefined : Buffer.from(init.body),
    });
    return route.fetcher(url, init);
  };
  return { sent, fetcher };
}

const at = (path) => `${ROUTE}/${path}`;
const listed = (files) => Buffer.from(JSON.stringify({ files }));

test('a preview of this commit’s src/ sends the manifest read, the pending manifest, every file of src/ in order with its bytes on disk, the deletion and the final manifest, and nothing else', async () => {
  const { sent, fetcher } = recorded(worker());
  await publishBranch('bb/x', { fetcher, token: 't', parallel: 1 });
  const files = await Promise.all(
    tree.map(async (file) => {
      const body = await readFile(join(src, file));
      return {
        method: 'PUT',
        url: at(`files/${file.split('/').map(encodeURIComponent).join('/')}`),
        authorization: 'Bearer t',
        length: String(body.length),
        body,
      };
    })
  );
  const plain = { authorization: 'Bearer t', length: undefined };
  assert.deepEqual(sent, [
    { method: 'GET', url: at('manifest'), ...plain, body: undefined },
    {
      method: 'PUT',
      url: at('manifest'),
      ...plain,
      body: listed([...new Set(['old/gone.js', ...tree])].sort()),
    },
    ...files,
    { method: 'DELETE', url: at('files/old/gone.js'), ...plain, body: undefined },
    { method: 'PUT', url: at('manifest'), ...plain, body: listed(tree) },
  ]);
});

async function refuses(t, made, reason, roots = [made.src, `${made.src}/`]) {
  const vars = actions(t);
  for (const root of roots) {
    const route = worker();
    const calls = [];
    const fetcher = (url, init) => {
      calls.push(url);
      return String(url).startsWith(env.ACTIONS_ID_TOKEN_REQUEST_URL)
        ? Response.json({ value: 'oidc-token' })
        : route.fetcher(url, init);
    };
    const result = await preview(vars, { fetcher, root });
    assert.deepEqual(Object.keys(result), ['refused'], root);
    assert.match(result.refused, /^preview refused: /);
    assert.match(result.refused.slice('preview refused: '.length), reason, root);
    assert.match(
      (await preview(vars, { fetcher, token: 't', root })).refused,
      /^preview refused: /
    );
    await assert.rejects(publishBranch('bb/x', { fetcher, root }), /publish refused: /);
    assert.deepEqual(calls, [], root);
    assert.deepEqual(route.bucket.manifest, ['old/gone.js']);
  }
}

for (const { name, layouts, root, reason } of refusals) {
  test(`no preview is published, nothing at all is requested, and the step summary says “preview refused:”, when ${name}`, async (t) => {
    for (const layout of layouts) await refuses(t, await scratch(t, layout, { root }), reason);
  });
}

test('no preview is published, and nothing at all is requested, when a name in src/ isn’t UTF-8', async (t) => {
  const made = await scratch(t);
  const restore = await unnamed(made);
  try {
    await refuses(t, made, /^"src\/seed" holds a name that isn't UTF-8: 61ff$/);
  } finally {
    restore();
  }
});

for (const race of races({ src: '', dir: '', outside: '' })) {
  test(`no preview is published, and nothing at all is requested, when ${race.name}`, async (t) => {
    for (const trailing of ['', '/']) {
      const made = await scratch(t);
      const { at, swap, reason } = races(made).find(({ name }) => name === race.name);
      const restore = swapping(at, swap);
      try {
        await refuses(t, made, reason, [`${made.src}${trailing}`]);
      } finally {
        restore();
      }
    }
  });
}

test('a preview refuses before writing anything when the route’s manifest lists a file that isn’t a key under the branch, or lists no files', async () => {
  for (const files of [...strays.map((stray) => ['old/gone.js', stray]), 'x', {}, null]) {
    const route = worker();
    route.bucket.manifest = files;
    const { sent, fetcher } = recorded(route);
    const result = await preview(
      { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/', GITHUB_HEAD_REF: 'bb/x' },
      { fetcher, token: 't' }
    );
    assert.match(
      result.refused,
      /^preview refused: the preview's manifest (lists .+, which isn't a key in the bucket|doesn't list its files)$/,
      JSON.stringify(files)
    );
    assert.deepEqual(
      sent.map(({ method, url }) => `${method} ${url}`),
      [`GET ${at('manifest')}`],
      JSON.stringify(files)
    );
    assert.deepEqual([...route.bucket.objects], ['old/gone.js']);
  }
});

test('a preview with a parallel that isn’t a whole number above 0 requests nothing', async () => {
  for (const parallel of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8', null]) {
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      throw new Error('no request');
    };
    await assert.rejects(
      publishBranch('bb/x', { fetcher, token: 't', parallel }),
      /^RangeError: parallel must be a whole number above 0, not /
    );
    assert.equal(calls, 0, String(parallel));
  }
});

test('every run that would publish a preview checks src/ first, whatever its branch, OIDC variables or token, and a run that gets no preview still sends nothing', async (t) => {
  const before = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  t.after(() => {
    if (before === undefined) delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else env.ACTIONS_ID_TOKEN_REQUEST_URL = before;
  });
  const good = await scratch(t);
  const bad = await scratch(t, { [GATE]: ON });
  const outcomes = { published: 0, skipped: 0 };
  for (const branch of [
    'bb/x',
    'bb/X',
    'bb/',
    'bb/a/b',
    'bb//x',
    'bb/-_-',
    'bb/lease-pilot',
    'bb/seven',
    'bb/www',
    `bb/${'x'.repeat(80)}`,
    undefined,
    '',
    'BB/x',
    ' bb/x',
    'xbb/x',
    'renovate/x',
    'main',
    'lease-pilot',
  ]) {
    for (const url of ['https://token.actions.example/', '', undefined]) {
      for (const token of ['t', undefined]) {
        const vars = { GITHUB_HEAD_REF: branch, ACTIONS_ID_TOKEN_REQUEST_URL: url };
        if (url === undefined) delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
        else env.ACTIONS_ID_TOKEN_REQUEST_URL = url;
        const run = async (root) => {
          const route = worker();
          let calls = 0;
          const fetcher = (request, init) => {
            calls += 1;
            return url && String(request).startsWith(url)
              ? Response.json({ value: 'oidc-token' })
              : route.fetcher(request, init);
          };
          return { result: await preview(vars, { fetcher, token, root: root.src }), calls };
        };
        const seen = JSON.stringify({ branch, url, token });
        const pass = await run(good);
        const fail = await run(bad);
        assert.equal(fail.calls, 0, seen);
        if (pass.calls > 0) {
          outcomes.published += 1;
          assert.deepEqual(pass.result, { url: 'https://bb-x.sliccy.ai/' }, seen);
          assert.match(fail.result.refused, /^preview refused: src\/seed\/lease-build\.js/, seen);
        } else {
          outcomes.skipped += 1;
          assert.match(pass.result.skipped, /gets no preview/, seen);
          assert.deepEqual(fail.result, pass.result, seen);
        }
      }
    }
  }
  assert.deepEqual(outcomes, { published: 20, skipped: 88 });
});

test('a preview uploads the bytes it checked, not what src/seed/lease-build.js or another file holds by the time it’s uploaded', async (t) => {
  const vars = actions(t);
  const { src: root } = await scratch(t);
  const { sent, fetcher: record } = recorded(worker());
  let changed = false;
  const fetcher = async (url, init) => {
    if (!changed) {
      changed = true;
      await writeFile(join(root, GATE), ON);
      await writeFile(join(root, 'index.html'), 'changed\n');
    }
    return record(url, init);
  };
  assert.deepEqual(await preview(vars, { fetcher, token: 't', root, parallel: 1 }), {
    url: 'https://bb-x.sliccy.ai/',
  });
  assert.equal(await readFile(join(root, GATE), 'utf8'), ON);
  const body = (file) => sent.find(({ url }) => url === at(`files/${file}`))?.body.toString();
  assert.equal(body(GATE), OFF);
  assert.equal(body('index.html'), '<!doctype html>\n');
});

test('a preview lists in its manifests the files it checked, not the files src/ holds by the time it’s uploaded', async (t) => {
  const { src: root, files } = await scratch(t);
  const route = worker();
  const { sent, fetcher: record } = recorded(route);
  let changed = false;
  const fetcher = async (url, init) => {
    if (!changed) {
      changed = true;
      await writeFile(join(root, 'late.js'), 'export {};\n');
      await rm(join(root, 'seed/boot.js'));
    }
    return record(url, init);
  };
  await publishBranch('bb/x', { fetcher, token: 't', root, parallel: 1 });
  const manifests = sent
    .filter(({ method, url }) => method === 'PUT' && url === at('manifest'))
    .map(({ body }) => JSON.parse(body).files);
  assert.deepEqual(manifests, [['old/gone.js', ...files].sort(), files]);
  assert.deepEqual([...route.bucket.objects].sort(), files);
  assert.equal(
    sent.find(({ url }) => url === at('files/seed/boot.js'))?.body.toString(),
    'export {};\n'
  );
});

const pull = {
  GITHUB_HEAD_REF: 'bb/x',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret-1',
};

test('a refused preview, run as ci.yml’s deploy step runs it, writes “preview refused:” to the step summary and as an error to the job log, sets no URL, exits 0 and sends nothing', async (t) => {
  for (const [layout, root] of [
    [{ [GATE]: ON }],
    [{ [GATE]: null }],
    [{ [GATE]: `${OFF} ` }],
    [{ 'seed/alias.js': { link: 'boot.js' } }],
    [{}, 'link'],
    [{ 'seed/pipe': { fifo: true } }],
  ]) {
    const made = await checkout(t, layout, { root });
    const run = await step(made, DEPLOY, { vars: pull });
    const line = run.summary.trimEnd();
    assert.match(line, /^preview refused: /, JSON.stringify(layout));
    assert.deepEqual(run, {
      status: 0,
      late: false,
      stdout: '',
      stderr: `::error title=preview::${line}\n`,
      summary: `${line}\n`,
      output: '',
      requests: [],
    });
  }
});

test('the preview reads no tree but its own src/: no environment variable and no argument makes ci.yml’s deploy step or the CLI check or upload another one', async (t) => {
  const good = await scratch(t);
  const made = await checkout(t, { [GATE]: ON });
  for (const command of [
    DEPLOY,
    `node edge/publish.mjs preview ${JSON.stringify(good.src)}`,
    `node edge/publish.mjs preview --root ${JSON.stringify(good.src)}`,
    `node edge/publish.mjs preview --root=${JSON.stringify(good.src)}`,
    `node edge/publish.mjs preview --src ${JSON.stringify(good.src)}`,
  ]) {
    const run = await step(made, command, { vars: pull, any: good.src });
    assert.equal(run.status, 0, command);
    assert.deepEqual(run.requests, [], command);
    assert.match(
      run.stderr,
      /^::error title=preview::preview refused: src\/seed\/lease-build\.js isn't exactly /
    );
  }
  const fine = await checkout(t);
  const run = await step(fine, DEPLOY, { vars: pull, any: good.src });
  assert.equal(run.status, 0);
  assert.equal(run.requests.length, 1);
  assert.ok(run.requests[0].startsWith(pull.ACTIONS_ID_TOKEN_REQUEST_URL), run.requests[0]);
  assert.equal(run.summary, 'preview failed: this test sends no request\n');
});

test('a preview that meets a FIFO in src/, there from the start or swapped in after its check, refuses without waiting on it', async (t) => {
  for (const fifo of [false, true]) {
    const made = await checkout(t, fifo ? {} : { [GATE]: { fifo: true } });
    const run = await step(made, DEPLOY, {
      vars: pull,
      fifo: fifo ? join(made.src, GATE) : undefined,
    });
    assert.equal(run.late, false);
    assert.equal(run.status, 0);
    assert.deepEqual(run.requests, []);
    assert.equal(run.summary, 'preview refused: "src/seed/lease-build.js" isn\'t a regular file\n');
  }
});

test('a branch whose name comes down to lease-pilot, however it is cased, separated or padded, gets no host of its own and publishes nothing', async () => {
  const route = worker();
  let calls = 0;
  const fetcher = (...args) => {
    calls += 1;
    return route.fetcher(...args);
  };
  for (const branch of [
    'lease-pilot',
    'LEASE-PILOT',
    'Lease-Pilot',
    'lEaSe-PiLoT',
    'lease_pilot',
    'LEASE_PILOT',
    'lease.pilot',
    'lease pilot',
    'lease+pilot',
    'lease\u2013pilot',
    'lease--pilot',
    'lease__pilot',
    'lease-_-pilot',
    'lease/pilot',
    'lease//pilot',
    'lease\\pilot',
    '-lease-pilot',
    'lease-pilot-',
    '--lease-pilot--',
    '_lease_pilot',
    'lease_pilot_',
    '__lease__pilot__',
    '-_lease_-_pilot_-',
    ' lease pilot ',
    '/lease-pilot',
    'lease-pilot/',
    '/lease/pilot/',
    '//lease-pilot//',
  ]) {
    assert.throws(() => label(branch), /has no host of its own/, branch);
    await assert.rejects(
      publishBranch(branch, { fetcher, token: 't' }),
      /has no host of its own/,
      branch
    );
  }
  assert.equal(calls, 0);
  for (const [branch, host] of [
    ['lease-pilots', 'lease-pilots'],
    ['lease-pilot-2', 'lease-pilot-2'],
    ['bb/edge-hosting', 'bb-edge-hosting'],
  ]) {
    assert.equal(label(branch), host);
  }
});
