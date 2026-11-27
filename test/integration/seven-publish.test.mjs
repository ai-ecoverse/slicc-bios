import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AwsClient } from 'aws4fetch';
import { API, publishSeven, S3 } from '../../edge/publish.mjs';
import {
  AFTER_RELEASE,
  checkout,
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

const key = (path) => `${S3}/${path.split('/').map(encodeURIComponent).join('/')}`;

test('a release of this commit’s src/ sends the token check, the manifest read, every file of src/ in order with its bytes on disk, the deletion and the new manifest, and nothing else', async () => {
  const r2 = cloudflare();
  await publishSeven({ token: TOKEN, fetcher: r2.fetcher, parallel: 1 });
  const files = await Promise.all(
    tree.map(async (file) => ({
      method: 'PUT',
      url: key(`seven/${file}`),
      body: await readFile(join(src, file)),
    }))
  );
  assert.deepEqual(
    r2.requests.map(({ method, url, body }) => ({ method, url, body })),
    [
      { method: 'GET', url: API, body: undefined },
      { method: 'GET', url: key('seven.json'), body: undefined },
      ...files,
      { method: 'DELETE', url: key('seven/old/gone.js'), body: undefined },
      {
        method: 'PUT',
        url: key('seven.json'),
        body: Buffer.from(JSON.stringify({ branch: 'main', files: tree })),
      },
    ]
  );
});

function counted(r2) {
  const calls = [];
  const fetcher = (...args) => {
    calls.push(args);
    return r2.fetcher(...args);
  };
  return { calls, fetcher };
}

async function refuses(made, reason, roots = [made.src, `${made.src}/`]) {
  for (const root of roots) {
    const r2 = cloudflare();
    const { calls, fetcher } = counted(r2);
    await assert.rejects(publishSeven({ token: TOKEN, fetcher, root }), (error) => {
      assert.match(error.message, /^publish refused: /, root);
      assert.match(error.message.slice('publish refused: '.length), reason, root);
      return true;
    });
    await assert.rejects(publishSeven({ token: undefined, fetcher, root }), /publish refused: /);
    assert.equal(calls.length, 0, root);
    assert.deepEqual([...r2.bucket.keys()].sort(), ['seven.json', 'seven/old/gone.js']);
  }
}

for (const { name, layouts, root, reason } of refusals) {
  test(`seven isn’t published, and nothing at all is requested, when ${name}`, async (t) => {
    for (const layout of layouts) await refuses(await scratch(t, layout, { root }), reason);
  });
}

test('seven isn’t published, and nothing at all is requested, when a name in src/ isn’t UTF-8', async (t) => {
  const made = await scratch(t);
  const restore = await unnamed(made);
  try {
    await refuses(made, /^"src\/seed" holds a name that isn't UTF-8: 61ff$/);
  } finally {
    restore();
  }
});

for (const race of races({ src: '', dir: '', outside: '' })) {
  test(`seven isn’t published, and nothing at all is requested, when ${race.name}`, async (t) => {
    for (const trailing of ['', '/']) {
      const made = await scratch(t);
      const { at, swap, reason } = races(made).find(({ name }) => name === race.name);
      const restore = swapping(at, swap);
      try {
        await refuses(made, reason, [`${made.src}${trailing}`]);
      } finally {
        restore();
      }
    }
  });
}

test('a release refuses before writing anything when seven.json lists a file that isn’t a key under seven/, or lists no files', async () => {
  for (const files of [...strays.map((stray) => ['old/gone.js', stray]), 'x', {}, null]) {
    const r2 = cloudflare({ manifest: { branch: 'main', files } });
    await assert.rejects(
      publishSeven({ token: TOKEN, fetcher: r2.fetcher }),
      /^Error: publish refused: seven\.json (lists .+, which isn't a key in the bucket|doesn't list its files)$/,
      JSON.stringify(files)
    );
    assert.deepEqual(
      r2.requests.map(({ method, url }) => `${method} ${url}`),
      [`GET ${API}`, `GET ${key('seven.json')}`],
      JSON.stringify(files)
    );
    assert.deepEqual([...r2.bucket.keys()].sort(), ['seven.json', 'seven/old/gone.js']);
  }
});

test('a release with a parallel that isn’t a whole number above 0 requests nothing', async () => {
  for (const parallel of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8', null]) {
    const r2 = cloudflare();
    const { calls, fetcher } = counted(r2);
    await assert.rejects(
      publishSeven({ token: TOKEN, fetcher, parallel }),
      /^RangeError: parallel must be a whole number above 0, not /
    );
    assert.equal(calls.length, 0, String(parallel));
  }
});

const release = { SLICC_BIOS_DEPLOY_TOKEN: TOKEN, RELEASE_VERSION: '1.2.3' };

test('a refused release, run as ci.yml’s after-release runs it, throws, fails the step, says why in the job log, and sends nothing', async (t) => {
  for (const [layout, root, reason] of [
    [{ [GATE]: ON }, 'dir', /src\/seed\/lease-build\.js isn't exactly /],
    [{ [GATE]: null }, 'dir', /src\/seed\/lease-build\.js is missing/],
    [{ [GATE]: `${OFF} ` }, 'dir', /src\/seed\/lease-build\.js isn't exactly /],
    [{ 'seed/alias.js': { link: 'boot.js' } }, 'dir', /"src\/seed\/alias\.js" is a symbolic link/],
    [{}, 'link', /src\/ is a symbolic link/],
    [{ 'seed/pipe': { fifo: true } }, 'dir', /"src\/seed\/pipe" isn't a regular file/],
  ]) {
    const made = await checkout(t, layout, { root });
    const { stderr, ...run } = await step(made, AFTER_RELEASE, { vars: release });
    assert.deepEqual(run, {
      status: 1,
      late: false,
      stdout: '',
      summary: 'Publishing v1.2.3 to seven\n',
      output: '',
      requests: [],
    });
    assert.match(stderr, new RegExp(`\\n\\S.*: publish refused: ${reason.source}`));
  }
});

test('the release reads no tree but its own src/: no environment variable and no argument makes ci.yml’s after-release or the CLI check or upload another one', async (t) => {
  const good = await scratch(t);
  const made = await checkout(t, { [GATE]: ON });
  for (const command of [
    AFTER_RELEASE,
    `node edge/publish.mjs main ${JSON.stringify(good.src)}`,
    `node edge/publish.mjs main --root ${JSON.stringify(good.src)}`,
    `node edge/publish.mjs main --root=${JSON.stringify(good.src)}`,
    `node edge/publish.mjs main --src ${JSON.stringify(good.src)}`,
  ]) {
    const run = await step(made, command, { vars: release, any: good.src });
    assert.equal(run.status, 1, command);
    assert.deepEqual(run.requests, [], command);
    assert.match(run.stderr, /\n\S.*: publish refused: src\/seed\/lease-build\.js isn't exactly /);
  }
  const fine = await checkout(t);
  const run = await step(fine, AFTER_RELEASE, { vars: release, any: good.src });
  assert.equal(run.status, 1);
  assert.deepEqual(run.requests, [API]);
  assert.match(run.stderr, /this test sends no request/);
});

test('a release that meets a FIFO in src/, there from the start or swapped in after its check, refuses without waiting on it', async (t) => {
  for (const fifo of [false, true]) {
    const made = await checkout(t, fifo ? {} : { [GATE]: { fifo: true } });
    const run = await step(made, AFTER_RELEASE, {
      vars: release,
      fifo: fifo ? join(made.src, GATE) : undefined,
    });
    assert.equal(run.late, false);
    assert.equal(run.status, 1);
    assert.deepEqual(run.requests, []);
    assert.equal(run.summary, 'Publishing v1.2.3 to seven\n');
    assert.match(
      run.stderr,
      /\n\S.*: publish refused: "src\/seed\/lease-build\.js" isn't a regular file/
    );
  }
});

test('a release uploads the bytes it checked, not what src/seed/lease-build.js or another file holds by the time it’s uploaded', async (t) => {
  const { src: root } = await scratch(t);
  const r2 = cloudflare();
  let changed = false;
  const fetcher = async (...args) => {
    if (!changed) {
      changed = true;
      await writeFile(join(root, GATE), ON);
      await writeFile(join(root, 'index.html'), 'changed\n');
    }
    return r2.fetcher(...args);
  };
  await publishSeven({ token: TOKEN, fetcher, root, parallel: 1 });
  assert.equal(await readFile(join(root, GATE), 'utf8'), ON);
  assert.equal(r2.bucket.get(`seven/${GATE}`), OFF);
  assert.equal(r2.bucket.get('seven/index.html'), '<!doctype html>\n');
});

test('a release lists in seven.json the files it checked, not the files src/ holds by the time it’s uploaded', async (t) => {
  const { src: root, files } = await scratch(t);
  const r2 = cloudflare({ manifest: { branch: 'main', files: ['old/gone.js'] } });
  let changed = false;
  const fetcher = async (...args) => {
    if (!changed) {
      changed = true;
      await writeFile(join(root, 'late.js'), 'export {};\n');
      await rm(join(root, 'seed/boot.js'));
    }
    return r2.fetcher(...args);
  };
  await publishSeven({ token: TOKEN, fetcher, root, parallel: 1 });
  assert.deepEqual(JSON.parse(r2.bucket.get('seven.json')), { branch: 'main', files });
  assert.equal(r2.bucket.has('seven/late.js'), false);
  assert.equal(r2.bucket.get('seven/seed/boot.js'), 'export {};\n');
});
