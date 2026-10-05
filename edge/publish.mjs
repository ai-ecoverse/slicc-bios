import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { argv, env, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

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

function wrangler(args, input) {
  return execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', ...args, '--remote'], {
    input,
    stdio: 'pipe',
    env: { ...env, CLOUDFLARE_ACCOUNT_ID: account },
  });
}

function files() {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

function prefix(name) {
  return name === 'seven' ? name : `branches/${name}`;
}

function previous(at) {
  let manifest;
  try {
    manifest = wrangler(['get', `${bucket}/${at}.json`, '--pipe']);
  } catch (error) {
    if (`${error.stderr}`.includes('The specified key does not exist')) return { files: [] };
    throw error;
  }
  return JSON.parse(manifest);
}

export function publish(branch) {
  const name = label(branch);
  const at = prefix(name);
  const { branch: owner = branch, files: before } = previous(at);
  if (owner !== branch) {
    throw new Error(`${name}.sliccy.ai already serves ${owner}, rename ${branch}`);
  }
  const current = files();
  for (const file of current) {
    wrangler(['put', `${bucket}/${at}/${file}`, '--file', join(root, file)]);
  }
  for (const file of before.filter((file) => !current.includes(file))) {
    wrangler(['delete', `${bucket}/${at}/${file}`]);
  }
  wrangler(['put', `${bucket}/${at}.json`, '--pipe'], JSON.stringify({ branch, files: current }));
  return `https://${name}.sliccy.ai/`;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  stdout.write(`${publish(argv[2])}\n`);
}
