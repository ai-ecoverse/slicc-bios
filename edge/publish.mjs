import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { argv, env, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { AwsClient } from 'aws4fetch';

const account = '155ec15a52a18a14801e04b019da5e5a';
const bucket = 'slicc-bios';
const root = fileURLToPath(new URL('../src/', import.meta.url));
const reserved = new Set(['seven', 'www']);

export function label(branch) {
  if (branch === 'main') return 'seven';
  const name = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
  if (!name || reserved.has(name)) throw new Error(`branch ${branch} has no host of its own`);
  return name;
}

function files() {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

export const API = `https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`;
export const S3 = `https://${account}.r2.cloudflarestorage.com/${bucket}`;

export async function r2(token, fetcher = fetch) {
  if (!token) throw new Error('no deploy token');
  const response = await fetcher(API, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  const id = body?.result?.id;
  if (!response.ok || body?.result?.status !== 'active' || typeof id !== 'string') {
    throw new Error(`the deploy token doesn't verify: ${response.status}`);
  }
  const client = new AwsClient({
    accessKeyId: id,
    secretAccessKey: createHash('sha256').update(token).digest('hex'),
    service: 's3',
    region: 'auto',
  });
  return async (method, key, body) => {
    const url = `${S3}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const signed = await client.sign(url, { method, body });
    const reply = await fetcher(signed);
    if (method === 'GET' && reply.status === 404) return null;
    if (!reply.ok) throw new Error(`${method} ${key}: ${reply.status}`);
    return reply;
  };
}

export async function publishSeven({
  token = env.SLICC_BIOS_DEPLOY_TOKEN,
  fetcher = fetch,
  parallel = 8,
} = {}) {
  const object = await r2(token, fetcher);
  const manifest = await object('GET', 'seven.json');
  const { branch: owner = 'main', files: before = [] } = manifest ? await manifest.json() : {};
  if (owner !== 'main') throw new Error(`seven.sliccy.ai serves ${owner}, not main`);
  const current = files();
  const queue = [...current];
  const put = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      await object('PUT', `seven/${file}`, readFileSync(join(root, file)));
    }
  };
  await Promise.all(Array.from({ length: parallel }, put));
  for (const file of before.filter((file) => !current.includes(file))) {
    await object('DELETE', `seven/${file}`);
  }
  await object('PUT', 'seven.json', JSON.stringify({ branch: 'main', files: current }));
  return 'https://seven.sliccy.ai/';
}

export const ROUTE = 'https://seven.sliccy.ai/api/publish';
export const AUDIENCE = 'https://sliccy.ai';

export async function oidc(fetcher = fetch) {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', AUDIENCE);
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!response.ok) throw new Error(`GitHub's OIDC token: ${response.status}`);
  return (await response.json()).value;
}

export async function publishBranch(branch, { fetcher = fetch, token, parallel = 8 } = {}) {
  label(branch);
  const authorization = `Bearer ${token ?? (await oidc(fetcher))}`;
  const call = async (path, init = {}) => {
    const response = await fetcher(`${ROUTE}/${path}`, {
      ...init,
      headers: { authorization, ...init.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error ?? ''}`.trim());
    return body;
  };
  const { files: before } = await call('manifest');
  const current = files();
  const pending = [...new Set([...before, ...current])].sort();
  await call('manifest', { method: 'PUT', body: JSON.stringify({ files: pending }) });
  const queue = [...current];
  const put = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const bytes = readFileSync(join(root, file));
      await call(`files/${file.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PUT',
        headers: { 'content-length': String(bytes.length) },
        body: bytes,
      });
    }
  };
  await Promise.all(Array.from({ length: parallel }, put));
  for (const file of before.filter((file) => !current.includes(file))) {
    await call(`files/${file.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  }
  return (await call('manifest', { method: 'PUT', body: JSON.stringify({ files: current }) })).url;
}

export async function preview(vars = env, options = {}) {
  const branch = vars.GITHUB_HEAD_REF ?? '';
  if (!branch.startsWith('bb/')) {
    return { skipped: `${branch || 'this run'} gets no preview, only bb/** branches do` };
  }
  if (!vars.ACTIONS_ID_TOKEN_REQUEST_URL) {
    return { skipped: `${branch} has no OIDC token, so it gets no preview` };
  }
  try {
    return { url: await publishBranch(branch, options) };
  } catch (error) {
    return { skipped: `preview failed: ${error.message}` };
  }
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const mode = argv[2];
  if (mode === 'main') stdout.write(`${await publishSeven()}\n`);
  else if (mode === 'preview') {
    const { url, skipped } = await preview();
    if (skipped) stdout.write(`${skipped}\n`);
    else {
      appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
      stdout.write(`${url}\n`);
    }
  } else throw new Error(`usage: publish.mjs main | preview, not ${mode}`);
}
