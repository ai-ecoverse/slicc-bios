import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { argv, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const bucket = 'slicc-bios';
const config = fileURLToPath(new URL('wrangler.json', import.meta.url));
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
  return execFileSync(
    'npx',
    ['--no-install', 'wrangler', 'r2', 'object', ...args, '--remote', '--config', config],
    { input, stdio: ['pipe', 'pipe', 'inherit'] }
  );
}

function files() {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

function previous(name) {
  try {
    return JSON.parse(wrangler(['get', `${bucket}/${name}.json`, '--pipe']));
  } catch {
    return [];
  }
}

export function publish(branch) {
  const name = label(branch);
  const current = files();
  for (const file of current) {
    wrangler(['put', `${bucket}/${name}/${file}`, '--file', join(root, file)]);
  }
  for (const file of previous(name).filter((file) => !current.includes(file))) {
    wrangler(['delete', `${bucket}/${name}/${file}`]);
  }
  wrangler(['put', `${bucket}/${name}.json`, '--pipe'], JSON.stringify(current));
  return `https://${name}.sliccy.com/`;
}

export function remove(branch) {
  const name = label(branch);
  for (const file of previous(name)) wrangler(['delete', `${bucket}/${name}/${file}`]);
  wrangler(['delete', `${bucket}/${name}.json`]);
  return `https://${name}.sliccy.com/`;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [command, branch] = argv.slice(2);
  stdout.write(`${{ publish, remove }[command](branch)}\n`);
}
