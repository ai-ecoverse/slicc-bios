import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { argv, chdir, env } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PACKAGES = join(ROOT, 'src/packages');
export const OUT = join(ROOT, 'node_modules/.cache/slicc-canary/pins.json');
export const GATED = /^@ai-ecoverse\/(slicc-kernel|slicc-cdp|slicc-jsh|wasi-|wasix-|wasm-|py-)/;
const REGISTRY = env.CANARY_REGISTRY ?? 'https://registry.npmjs.org/';
const PNPM = ['--yes', 'pnpm@12'];
const PNPM_LOCK_ENTRY =
  /^ {2}'?(@[^/\s']+\/[^@'\s]+)@([^'(\s]+)'?:\n {4}resolution: \{integrity: ([^,}\s]+)/gm;

export function parse(spec) {
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (at <= 0 || !/^@[\w.-]+\/[\w.-]+$/.test(name))
    throw new Error(`not a scoped name@version: ${spec}`);
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`not an exact version: ${spec}`);
  return { name, version };
}

export function specs(args) {
  return args.flatMap((arg) => {
    const text = arg.trim();
    if (!text) return [];
    if (text.startsWith('[')) return JSON.parse(text);
    return text.split(/[\s,]+/).filter(Boolean);
  });
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

export function registryUrl(name, version) {
  return `${REGISTRY}${name.replace('/', '%2f')}${version ? `/${version}` : ''}`;
}

async function harnessDownload() {
  const cdn = join(ROOT, 'node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs');
  return (await import(pathToFileURL(cdn).href)).download;
}

export async function resolve({ name, version }, download) {
  const manifest = await json(registryUrl(name, version));
  const { tarball, integrity } = manifest.dist ?? {};
  if (!tarball || !/^sha512-/.test(integrity ?? '')) {
    throw new Error(`${name}@${version} has no sha512 tarball on npm`);
  }
  const bytes = Buffer.from(await download(tarball));
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== integrity) throw new Error(`${name}@${version}: the tarball isn't ${integrity}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { name, version, integrity, sha256, tarball, size: bytes.length };
}

async function exists(path) {
  return stat(path).then(
    () => true,
    () => false
  );
}

export async function projects(dir = PACKAGES) {
  const found = [];
  if (await exists(join(dir, 'package.json'))) found.push(dir);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      found.push(...(await projects(join(dir, entry.name))));
    }
  }
  return found;
}

const write = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

function npmEntries(lock, name) {
  return Object.entries(lock.packages ?? {}).filter(
    ([path]) => path && path.split('node_modules/').at(-1) === name
  );
}

function npmDependents(lock, name) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path && entry.dependencies?.[name])
    .map(([path, entry]) => `${path.split('node_modules/').at(-1)}@${entry.version}`);
}

function pnpmVersions(text, name) {
  return [...text.matchAll(PNPM_LOCK_ENTRY)]
    .filter(([, found]) => found === name)
    .map(([, , version, integrity]) => ({ version, integrity }));
}

function addOverride(workspace, name, version) {
  const line = `  '${name}': ${version}\n`;
  const kept = workspace
    .split('\n')
    .filter((row) => !row.startsWith(`  '${name}':`) && !row.startsWith(`  ${name}:`))
    .join('\n');
  if (/^overrides:\n/m.test(kept)) return kept.replace(/^overrides:\n/m, `overrides:\n${line}`);
  return `${kept.replace(/\n*$/, '\n')}overrides:\n${line}`;
}

async function isolated(dir, files, command, args) {
  const scratch = await mkdtemp(join(tmpdir(), 'slicc-canary-'));
  try {
    for (const file of files) {
      if (await exists(join(dir, file))) await copyFile(join(dir, file), join(scratch, file));
    }
    await exec(command, args, { cwd: scratch, maxBuffer: 64 * 1024 * 1024 });
    for (const file of files) {
      if (await exists(join(scratch, file))) await copyFile(join(scratch, file), join(dir, file));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const NPM_LOCK = ['package.json', 'package-lock.json'];
const PNPM_LOCK = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

function checkNpm(lock, file, direct) {
  for (const { name, version, integrity } of direct) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (entry?.version !== version || entry?.integrity !== integrity) {
      throw new Error(`${file} didn't take ${name}@${version}`);
    }
  }
}

async function rewriteNpm(dir, overrides, direct, report) {
  const at = (file) => join(dir, file);
  const file = relative(PACKAGES, at('package-lock.json'));
  const lock = JSON.parse(await readFile(at('package-lock.json'), 'utf8'));
  const touched = new Set(direct.map(({ name }) => name));
  for (const { name } of overrides.filter((o) => !touched.has(o.name))) {
    for (const [, entry] of npmEntries(lock, name)) {
      report.held.push({ file, name, version: entry.version, by: npmDependents(lock, name) });
    }
  }
  if (!direct.length) return;
  await isolated(dir, NPM_LOCK, 'npm', [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  report.changed.add(file);
  checkNpm(JSON.parse(await readFile(at('package-lock.json'), 'utf8')), file, direct);
}

function checkPnpm(text, file, direct, forced) {
  for (const { name, version, integrity } of [...direct, ...forced]) {
    const versions = pnpmVersions(text, name);
    if (!versions.some((found) => found.version === version && found.integrity === integrity)) {
      throw new Error(`${file} didn't take ${name}@${version}`);
    }
    const isForced = forced.some((override) => override.name === name);
    if (isForced && versions.some((found) => found.version !== version)) {
      throw new Error(`${file} kept another ${name}`);
    }
  }
}

async function rewritePnpm(dir, overrides, direct, report) {
  const at = (file) => join(dir, file);
  const file = relative(PACKAGES, at('pnpm-lock.yaml'));
  const text = await readFile(at('pnpm-lock.yaml'), 'utf8');
  const touched = new Set(direct.map(({ name }) => name));
  const workspace = await exists(at('pnpm-workspace.yaml'));
  const transitive = overrides.filter(
    (o) => !touched.has(o.name) && pnpmVersions(text, o.name).length
  );
  const forced = workspace ? transitive : [];
  for (const { name } of workspace ? [] : transitive) {
    for (const { version } of pnpmVersions(text, name)) {
      report.held.push({ file, name, version, by: ['no pnpm-workspace.yaml for an override'] });
    }
  }
  if (forced.length) {
    let yaml = await readFile(at('pnpm-workspace.yaml'), 'utf8');
    for (const { name, version } of forced) yaml = addOverride(yaml, name, version);
    await writeFile(at('pnpm-workspace.yaml'), yaml);
    report.changed.add(relative(PACKAGES, at('pnpm-workspace.yaml')));
  }
  if (!direct.length && !forced.length) return;
  await isolated(dir, PNPM_LOCK, 'npx', [
    ...PNPM,
    'install',
    '--lockfile-only',
    '--ignore-scripts',
  ]);
  report.changed.add(file);
  checkPnpm(await readFile(at('pnpm-lock.yaml'), 'utf8'), file, direct, forced);
}

async function rewrite(dir, overrides, report) {
  const at = (file) => join(dir, file);
  const manifest = JSON.parse(await readFile(at('package.json'), 'utf8'));
  const direct = overrides.filter(({ name }) => manifest.dependencies?.[name]);
  for (const { name, version } of direct) manifest.dependencies[name] = version;
  if (direct.length) {
    await write(at('package.json'), manifest);
    report.changed.add(relative(PACKAGES, at('package.json')));
  }
  if (await exists(at('package-lock.json'))) await rewriteNpm(dir, overrides, direct, report);
  if (await exists(at('pnpm-lock.yaml'))) await rewritePnpm(dir, overrides, direct, report);
}

export async function lockedAll() {
  const found = new Map();
  const add = (key, file, integrity) => {
    const entry = found.get(key) ?? { integrity, files: [] };
    entry.files.push(file);
    found.set(key, entry);
  };
  for (const dir of await projects()) {
    const file = (name) => relative(PACKAGES, join(dir, name));
    if (await exists(join(dir, 'package-lock.json'))) {
      const lock = JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8'));
      for (const [path, entry] of Object.entries(lock.packages ?? {})) {
        const name = path.split('node_modules/').at(-1);
        if (path) add(`${name}@${entry.version}`, file('package-lock.json'), entry.integrity);
      }
    }
    if (await exists(join(dir, 'pnpm-lock.yaml'))) {
      const text = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8');
      for (const [, name, version, integrity] of text.matchAll(PNPM_LOCK_ENTRY)) {
        add(`${name}@${version}`, file('pnpm-lock.yaml'), integrity);
      }
    }
  }
  return found;
}

export async function overridePins(list, { out = OUT } = {}) {
  chdir(ROOT);
  const wanted = list.map(parse);
  const names = new Set();
  for (const { name } of wanted) {
    if (names.has(name)) throw new Error(`${name} is overridden twice`);
    names.add(name);
  }
  const download = await harnessDownload();
  const overrides = [];
  for (const spec of wanted) overrides.push(await resolve(spec, download));
  const report = { changed: new Set(), held: [] };
  for (const dir of await projects()) await rewrite(dir, overrides, report);
  const locked = await lockedAll();
  const nowhere = overrides
    .map(({ name, version }) => `${name}@${version}`)
    .filter((key) => !locked.has(key));
  if (nowhere.length) throw new Error(`bios pins none of these: ${nowhere.join(', ')}`);
  const certs = JSON.parse(await readFile(join(PACKAGES, 'certs.json'), 'utf8'));
  const candidates = {};
  for (const [key, entry] of locked) {
    if (!GATED.test(key.slice(0, key.lastIndexOf('@')))) continue;
    if (certs[key]?.integrity === entry.integrity) continue;
    const override = overrides.find((o) => `${o.name}@${o.version}` === key);
    candidates[key] = {
      integrity: entry.integrity,
      files: entry.files,
      via: override ? 'override' : 'dependency',
      ...(override ? { sha256: override.sha256 } : {}),
    };
  }
  const result = {
    overrides,
    changed: [...report.changed].sort(),
    held: report.held,
    candidates,
  };
  await mkdir(dirname(out), { recursive: true });
  await write(out, result);
  return result;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const args = argv.slice(2);
  const index = args.indexOf('--out');
  const out = index >= 0 ? args.splice(index, 2)[1] : OUT;
  const result = await overridePins(specs(args), { out });
  for (const { name, version, sha256 } of result.overrides) {
    console.log(`override ${name}@${version} sha256=${sha256}`);
  }
  for (const file of result.changed) console.log(`rewrote src/packages/${file}`);
  for (const { file, name, version, by } of result.held) {
    console.log(`held ${name}@${version} in src/packages/${file} by ${by.join(', ')}`);
  }
  for (const [key, { via }] of Object.entries(result.candidates)) {
    console.log(`candidate, not certified: ${key} (${via})`);
  }
}
