import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { argv, chdir, env } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PACKAGES = join(ROOT, 'src/packages');
export const OUT = join(ROOT, 'node_modules/.cache/slicc-canary/pins.json');
export const CDN = join(ROOT, 'node_modules/.cache/slicc-harness/cdn');
export const NPM = 'https://registry.npmjs.org/';
const PUBLISHED = '2000-01-01T00:00:00.000Z';
export const GATED =
  /^@ai-ecoverse\/(slicc-kernel|slicc-cdp|slicc-clipboard|slicc-jsh|wasi-|wasix-|wasm-|py-)/;
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
  if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) throw new Error(`not an exact version: ${spec}`);
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

export function tarballUrl(name, version) {
  return `${NPM}${name}/-/${name.split('/').pop()}-${version}.tgz`;
}

export function packed(name) {
  return `${name.replace(/^@/, '').replace('/', '-')}-`;
}

export async function artifactPackage({ file, sha256, package: wanted, ...source }) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? ''))
    throw new Error(`candidate sha256 must be 64 hex digits: ${sha256}`);
  const bytes = await readFile(file);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) {
    throw new Error(
      `candidate ${basename(file)}: its sha256 is ${actual}, not ${sha256}; refusing it`
    );
  }
  const { stdout } = await exec('tar', ['-xzOf', file, 'package/package.json'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const manifest = JSON.parse(stdout);
  if (manifest.name !== wanted) {
    throw new Error(`candidate ${basename(file)} is ${manifest.name}, not ${wanted}`);
  }
  if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(manifest.version ?? '')) {
    throw new Error(`candidate ${manifest.name} has no exact version: ${manifest.version}`);
  }
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  return {
    name: manifest.name,
    version: manifest.version,
    integrity,
    sha256,
    tarball: tarballUrl(manifest.name, manifest.version),
    size: bytes.length,
    via: 'artifact',
    source,
    manifest,
    bytes,
  };
}

export async function findPacked(dir, name) {
  const found = (await readdir(dir)).filter(
    (file) => file.endsWith('.tgz') && file.startsWith(packed(name))
  );
  if (found.length !== 1) {
    throw new Error(`the candidate artifact needs one ${packed(name)}*.tgz, found ${found.length}`);
  }
  return join(dir, found[0]);
}

export function seeded(tarball, cdn = CDN) {
  const { host, pathname } = new URL(tarball);
  return join(cdn, host, pathname.replaceAll('%', '%25'));
}

export async function seed(candidate, cdn = CDN) {
  const file = seeded(candidate.tarball, cdn);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, candidate.bytes);
  return file;
}

function relocate(packument, from, to) {
  for (const entry of Object.values(packument.versions ?? {})) {
    if (typeof entry?.dist?.tarball === 'string' && entry.dist.tarball.startsWith(from)) {
      entry.dist.tarball = to + entry.dist.tarball.slice(from.length);
    }
  }
  return packument;
}

export function withCandidate(packument, { name, version, manifest, integrity }, tarball) {
  return {
    ...packument,
    versions: {
      ...packument.versions,
      [version]: { ...manifest, _id: `${name}@${version}`, dist: { tarball, integrity } },
    },
    time: { ...packument.time, [version]: packument.time?.[version] ?? PUBLISHED },
  };
}

export async function servedCandidates(pins, cdn = CDN) {
  const { overrides = [] } = JSON.parse(await readFile(pins, 'utf8'));
  const found = new Map();
  for (const pinned of overrides.filter(({ via }) => via === 'artifact')) {
    const file = seeded(tarballUrl(pinned.name, pinned.version), cdn);
    const verified = await artifactPackage({ file, sha256: pinned.sha256, package: pinned.name });
    if (verified.version !== pinned.version || verified.integrity !== pinned.integrity) {
      throw new Error(
        `candidate ${basename(file)} is not the ${pinned.name}@${pinned.version} that ${basename(pins)} names; refusing it`
      );
    }
    found.set(pinned.name, verified);
  }
  return found;
}

function packumentName(input) {
  const url = URL.parse(input instanceof Request ? input.url : String(input));
  if (!url || `${url.origin}/` !== NPM) return null;
  try {
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
}

export function servingFetch(upstream, candidates) {
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const name = packumentName(input);
    const candidate = method.toUpperCase() === 'GET' && candidates.get(name);
    if (!candidate) return upstream(input, init);
    const found = await upstream(input, init);
    if (!found.ok && found.status !== 404) return found;
    const packument = found.ok
      ? await found.json()
      : { name, 'dist-tags': {}, versions: {}, time: {} };
    return Response.json(withCandidate(packument, candidate, candidate.tarball));
  };
}

export async function serveCandidates(pins, { cdn = CDN, target = globalThis } = {}) {
  const candidates = await servedCandidates(pins, cdn);
  if (candidates.size) target.fetch = servingFetch(target.fetch, candidates);
  return candidates;
}

export async function registry(candidates, upstream = REGISTRY) {
  const byName = new Map(candidates.map((c) => [c.name, c]));
  let origin = '';
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://x').pathname.slice(1));
      const tarball = candidates.find(
        (c) => path === `${c.name}/-/${c.name.split('/').pop()}-${c.version}.tgz`
      );
      if (tarball) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(tarball.bytes);
      }
      const name = path.includes('/-/') ? null : path;
      const found = await fetch(`${upstream}${name === null ? path : path.replace('/', '%2f')}`, {
        headers: { accept: request.headers.accept ?? 'application/json' },
        signal: AbortSignal.timeout(60000),
      });
      const candidate = name && byName.get(name);
      if (!found.ok && !candidate) {
        response.writeHead(found.status);
        return response.end();
      }
      if (name === null) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(Buffer.from(await found.arrayBuffer()));
      }
      const packument = relocate(
        found.ok ? await found.json() : { name, 'dist-tags': {}, versions: {}, time: {} },
        upstream,
        `${origin}/`
      );
      const served = candidate
        ? withCandidate(packument, candidate, `${origin}/${candidate.tarball.slice(NPM.length)}`)
        : packument;
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(served));
    } catch (error) {
      response.writeHead(502);
      response.end(String(error.message));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/`,
    origin,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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

async function isolated(dir, files, command, args, local) {
  const scratch = await mkdtemp(join(tmpdir(), 'slicc-canary-'));
  try {
    for (const file of files) {
      if (await exists(join(dir, file))) await copyFile(join(dir, file), join(scratch, file));
    }
    const extra = local ? [`--registry=${local.url}`] : [];
    await exec(command, [...args, ...extra], { cwd: scratch, maxBuffer: 64 * 1024 * 1024 });
    for (const file of files) {
      if (!(await exists(join(scratch, file)))) continue;
      if (local && file !== 'package.json') {
        const text = await readFile(join(scratch, file), 'utf8');
        await writeFile(join(dir, file), text.replaceAll(`${local.origin}/`, NPM));
      } else {
        await copyFile(join(scratch, file), join(dir, file));
      }
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

async function rewriteNpm(dir, overrides, direct, report, { packages, local }) {
  const at = (file) => join(dir, file);
  const file = relative(packages, at('package-lock.json'));
  const lock = JSON.parse(await readFile(at('package-lock.json'), 'utf8'));
  const touched = new Set(direct.map(({ name }) => name));
  for (const { name } of overrides.filter((o) => !touched.has(o.name))) {
    for (const [, entry] of npmEntries(lock, name)) {
      report.held.push({ file, name, version: entry.version, by: npmDependents(lock, name) });
    }
  }
  if (!direct.length) return;
  await isolated(
    dir,
    NPM_LOCK,
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    local
  );
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

async function rewritePnpm(dir, overrides, direct, report, { packages, local }) {
  const at = (file) => join(dir, file);
  const file = relative(packages, at('pnpm-lock.yaml'));
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
    report.changed.add(relative(packages, at('pnpm-workspace.yaml')));
  }
  if (!direct.length && !forced.length) return;
  await isolated(
    dir,
    PNPM_LOCK,
    'npx',
    [...PNPM, 'install', '--lockfile-only', '--ignore-scripts'],
    local
  );
  report.changed.add(file);
  checkPnpm(await readFile(at('pnpm-lock.yaml'), 'utf8'), file, direct, forced);
}

async function rewrite(dir, overrides, report, options) {
  const at = (file) => join(dir, file);
  const manifest = JSON.parse(await readFile(at('package.json'), 'utf8'));
  const direct = overrides.filter(({ name }) => manifest.dependencies?.[name]);
  for (const { name, version } of direct) manifest.dependencies[name] = version;
  if (direct.length) {
    await write(at('package.json'), manifest);
    report.changed.add(relative(options.packages, at('package.json')));
  }
  if (await exists(at('package-lock.json')))
    await rewriteNpm(dir, overrides, direct, report, options);
  if (await exists(at('pnpm-lock.yaml')))
    await rewritePnpm(dir, overrides, direct, report, options);
}

export async function lockedAll(packages = PACKAGES) {
  const found = new Map();
  const add = (key, file, integrity) => {
    const entry = found.get(key) ?? { integrity, files: [] };
    entry.files.push(file);
    found.set(key, entry);
  };
  for (const dir of await projects(packages)) {
    const file = (name) => relative(packages, join(dir, name));
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

export async function overridePins(
  list,
  { out = OUT, artifacts = [], packages = PACKAGES, cdn = CDN } = {}
) {
  chdir(ROOT);
  const wanted = list.map(parse);
  const candidates = [];
  for (const artifact of artifacts) candidates.push(await artifactPackage(artifact));
  const names = new Set();
  for (const { name } of [...wanted, ...candidates]) {
    if (names.has(name)) throw new Error(`${name} is overridden twice`);
    names.add(name);
  }
  const overrides = [];
  if (wanted.length) {
    const download = await harnessDownload();
    for (const spec of wanted) overrides.push(await resolve(spec, download));
  }
  for (const candidate of candidates) {
    await seed(candidate, cdn);
    overrides.push(candidate);
  }
  const local = candidates.length ? await registry(candidates) : null;
  const report = { changed: new Set(), held: [] };
  try {
    for (const dir of await projects(packages)) {
      await rewrite(dir, overrides, report, { packages, local });
    }
  } finally {
    await local?.close();
  }
  const locked = await lockedAll(packages);
  const nowhere = overrides
    .map(({ name, version }) => `${name}@${version}`)
    .filter((key) => !locked.has(key));
  if (nowhere.length) throw new Error(`bios pins none of these: ${nowhere.join(', ')}`);
  const certs = JSON.parse(await readFile(join(packages, 'certs.json'), 'utf8'));
  const found = {};
  for (const [key, entry] of locked) {
    if (!GATED.test(key.slice(0, key.lastIndexOf('@')))) continue;
    if (certs[key]?.integrity === entry.integrity) continue;
    const override = overrides.find((o) => `${o.name}@${o.version}` === key);
    found[key] = {
      integrity: entry.integrity,
      files: entry.files,
      via: override ? (override.via ?? 'override') : 'dependency',
      ...(override ? { sha256: override.sha256 } : {}),
      ...(override?.source ? { source: override.source } : {}),
    };
  }
  const result = {
    overrides: overrides.map(
      ({ name, version, integrity, sha256, tarball, size, via, source }) => ({
        name,
        version,
        integrity,
        sha256,
        tarball,
        size,
        ...(via ? { via } : {}),
        ...(source ? { source } : {}),
      })
    ),
    changed: [...report.changed].sort(),
    held: report.held,
    candidates: found,
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
