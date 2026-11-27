import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { argv, env, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { AwsClient } from 'aws4fetch';

const account = '155ec15a52a18a14801e04b019da5e5a';
const bucket = 'slicc-bios';
const root = fileURLToPath(new URL('../src/', import.meta.url));
const reserved = new Set(['seven', 'www', 'lease-pilot']);
const GATE = 'seed/lease-build.js';
const OFF = Buffer.from('export const LEASE_PRODUCT_VERSION = 0;\n');
const OPEN = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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

class Refused extends Error {
  constructor(reason) {
    super(`publish refused: ${reason}`);
    this.reason = reason;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shown = (key) => (key ? JSON.stringify(`src/${key}`) : 'src/');

function guarded(key, action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(`${shown(key)} can't be read (${error.code ?? error.message})`);
  }
}

function canonical(key) {
  return (
    typeof key === 'string' &&
    key.isWellFormed() &&
    !/[\\\0]|%2f|%5c/i.test(key) &&
    key.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function decoded(raw) {
  try {
    return utf8.decode(raw);
  } catch {
    return null;
  }
}

function named(raw, key) {
  const name = decoded(raw);
  if (name === null || !Buffer.from(name).equals(raw)) {
    throw new Refused(`${shown(key)} holds a name that isn't UTF-8: ${raw.toString('hex')}`);
  }
  return name;
}

function read(path, key) {
  const fd = openSync(path, OPEN);
  try {
    if (!fstatSync(fd).isFile()) throw new Refused(`${shown(key)} isn't a regular file`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function checked(dir) {
  const start = dir.replace(/[\\/]+$/, '');
  const top = guarded('', () => lstatSync(start));
  if (top.isSymbolicLink()) throw new Refused('src/ is a symbolic link');
  if (!top.isDirectory()) throw new Refused("src/ isn't a directory");
  const base = guarded('', () => realpathSync(start));
  const upload = [];
  const visit = (path, key) => {
    const names = guarded(key, () => readdirSync(path, { encoding: 'buffer' }));
    for (const raw of names) {
      const name = named(raw, key);
      const file = key ? `${key}/${name}` : name;
      if (!canonical(file)) throw new Refused(`${shown(file)} can't be a key in the bucket`);
      const at = join(path, name);
      const entry = guarded(file, () => lstatSync(at));
      if (entry.isSymbolicLink()) throw new Refused(`${shown(file)} is a symbolic link`);
      if (entry.isDirectory()) {
        visit(at, file);
        continue;
      }
      if (!entry.isFile()) throw new Refused(`${shown(file)} isn't a regular file`);
      const bytes = guarded(file, () => read(at, file));
      if (guarded(key, () => realpathSync(path)) !== (key ? join(base, key) : base)) {
        throw new Refused(`${shown(key)} moved while it was read`);
      }
      upload.push(Object.freeze({ file, bytes, sha256: sha256(bytes) }));
    }
  };
  visit(start, '');
  upload.sort((a, b) => (a.file < b.file ? -1 : 1));
  const gate = upload.find(({ file }) => file === GATE);
  if (!gate) throw new Refused(`src/${GATE} is missing`);
  if (!gate.bytes.equals(OFF)) {
    throw new Refused(`src/${GATE} isn't exactly ${JSON.stringify(OFF.toString())}`);
  }
  return Object.freeze(upload);
}

function listed(files, where) {
  if (!Array.isArray(files)) throw new Refused(`${where} doesn't list its files`);
  const odd = files.findIndex((file) => !canonical(file));
  if (odd !== -1) {
    throw new Refused(`${where} lists ${inspect(files[odd])}, which isn't a key in the bucket`);
  }
  return files;
}

function lanes(parallel) {
  if (!Number.isInteger(parallel) || parallel < 1) {
    throw new RangeError(`parallel must be a whole number above 0, not ${inspect(parallel)}`);
  }
  return parallel;
}

function verified({ file, bytes, sha256: digest }) {
  if (sha256(bytes) !== digest) throw new Error(`src/${file} changed after it was checked`);
  return bytes;
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
  root: dir = root,
} = {}) {
  const width = lanes(parallel);
  const upload = checked(dir);
  const current = upload.map(({ file }) => file);
  const object = await r2(token, fetcher);
  const manifest = await object('GET', 'seven.json');
  const { branch: owner = 'main', files: before = [] } = manifest ? await manifest.json() : {};
  if (owner !== 'main') throw new Error(`seven.sliccy.ai serves ${owner}, not main`);
  listed(before, 'seven.json');
  const queue = [...upload];
  const put = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      await object('PUT', `seven/${entry.file}`, verified(entry));
    }
  };
  await Promise.all(Array.from({ length: width }, put));
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

export async function publishBranch(
  branch,
  { fetcher = fetch, token, parallel = 8, root: dir = root } = {}
) {
  const width = lanes(parallel);
  const upload = checked(dir);
  label(branch);
  const current = upload.map(({ file }) => file);
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
  listed(before, "the preview's manifest");
  const pending = [...new Set([...before, ...current])].sort();
  await call('manifest', { method: 'PUT', body: JSON.stringify({ files: pending }) });
  const queue = [...upload];
  const put = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const bytes = verified(entry);
      await call(`files/${entry.file.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PUT',
        headers: { 'content-length': String(bytes.length) },
        body: bytes,
      });
    }
  };
  await Promise.all(Array.from({ length: width }, put));
  for (const file of before.filter((file) => !current.includes(file))) {
    await call(`files/${file.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  }
  return (await call('manifest', { method: 'PUT', body: JSON.stringify({ files: current }) })).url;
}

function masked(message, secrets) {
  return secrets
    .filter(Boolean)
    .reduce((text, secret) => text.replaceAll(secret, '***'), message)
    .replace(/eyJ[\w.-]*/g, '***');
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
    if (error instanceof Refused) return { refused: `preview refused: ${error.reason}` };
    const secrets = [options.token, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN];
    return { skipped: `preview failed: ${masked(`${error.message}`, secrets)}` };
  }
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const mode = argv[2];
  if (mode === 'main') stdout.write(`${await publishSeven()}\n`);
  else if (mode === 'preview') {
    const { url, skipped, refused } = await preview();
    const reason = refused ?? skipped;
    if (reason) {
      stdout.write(`${reason}\n`);
      const data = reason.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
      stderr.write(`::${refused ? 'error' : 'warning'} title=preview::${data}\n`);
    } else {
      appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
      stdout.write(`${url}\n`);
    }
  } else throw new Error(`usage: publish.mjs main | preview, not ${mode}`);
}
