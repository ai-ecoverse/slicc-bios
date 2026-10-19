import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const DOCS = /^(?:[^/]+\/)*[^/]+\.md$|^docs\//;
export const TESTS = /^test\/integration\/(?:vendors\/)?[^/]+\.test\.mjs$/;
export const DURATIONS = 'scripts/ci/durations.json';
export const CATALOG = /^src\/packages\/(?:optional\/.+|certs\.json)$/;
export const PINS =
  /^(?:package\.json|package-lock\.json|src\/packages\/(?:(?:agent|grammars|tailscale|optional|optional\/projects\/[^/]+)\/)?(?:package\.json|package-lock\.json|pnpm-lock\.yaml))$/;
const MANIFEST = /(?:^|\/)package\.json$/;
const LOCK = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml)$/;
const KEYED = /^src\/packages\/(?:optional\/(?:catalog|retired)\.json|certs\.json)$/;
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const full = (reason) => ({ mode: 'full', reason, rows: null, vendors: true });

export function glob(pattern) {
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}$`);
}

export function rowsOf(name, map) {
  const hit = map.packages.find(([pattern]) => glob(pattern).test(name));
  return hit ? hit[1] : null;
}

function parse(text) {
  if (text === null) return {};
  return JSON.parse(text);
}

function deps(json) {
  const out = {};
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(json[field] ?? {})) out[`${field}:${name}`] = spec;
  }
  return out;
}

function rest(json) {
  const copy = { ...json };
  for (const field of FIELDS) delete copy[field];
  return JSON.stringify(copy);
}

function differing(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

function unversioned(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

export function packagesChanged(file, before, after) {
  const was = parse(before);
  const now = parse(after);
  if (MANIFEST.test(file)) {
    if (rest(was) !== rest(now)) return { error: `${file} changed beyond its dependencies` };
    return {
      names: differing(deps(was), deps(now)).map((key) => key.slice(key.indexOf(':') + 1)),
    };
  }
  if (KEYED.test(file)) {
    const names = differing(was, now);
    return { names: file.endsWith('certs.json') ? names.map(unversioned) : names };
  }
  return { names: [] };
}

const VENDORS = 'test/integration/vendors/';
const row = (name) => `${name}.test.mjs`;

function sort(changed) {
  const kinds = { docs: [], tests: [], timing: [], catalog: [], pins: [], other: [] };
  for (const file of changed) {
    if (DOCS.test(file)) kinds.docs.push(file);
    else if (TESTS.test(file)) kinds.tests.push(file);
    else if (file === DURATIONS) kinds.timing.push(file);
    else if (CATALOG.test(file)) kinds.catalog.push(file);
    else if (PINS.test(file)) kinds.pins.push(file);
    else kinds.other.push(file);
  }
  return kinds;
}

function names(files, read) {
  const found = new Set();
  let locks = false;
  for (const file of files) {
    if (LOCK.test(file)) {
      locks = true;
      continue;
    }
    const changed = packagesChanged(file, read('base', file), read('head', file));
    if (changed.error) return { error: changed.error };
    for (const name of changed.names) found.add(name);
  }
  if (locks && !found.size) return { error: 'a lockfile changed without a pin change' };
  return { names: [...found].sort() };
}

function packageRows(list, map, rows) {
  let vendors = false;
  for (const name of list) {
    const own = rowsOf(name, map);
    if (own === null) return { error: `${name} has no rows in scripts/ci/scopes.json` };
    if (own.includes('full')) return { error: `${name} needs the full suite` };
    for (const name of own) {
      if (name === 'vendors') vendors = true;
      else rows.add(row(name));
    }
  }
  return { vendors };
}

export function scope({ event, changed, read, map }) {
  if (event !== 'pull_request') return full(`a ${event || 'manual'} run is always full`);
  if (!changed?.length) return full('no changed files found');
  const kinds = sort(changed);
  if (kinds.other.length) return full(`${kinds.other[0]} needs the full suite`);
  const rows = new Set(
    kinds.tests.filter((file) => !file.startsWith(VENDORS)).map((file) => file.slice(17))
  );
  const vendorTests = kinds.tests.some((file) => file.startsWith(VENDORS));
  if (kinds.timing.length) for (const name of map.durations) rows.add(row(name));
  if (!kinds.catalog.length && !kinds.pins.length) {
    const mode = rows.size ? 'tests' : 'docs';
    const reason = rows.size
      ? `${rows.size} changed test files`
      : `${kinds.docs.length} docs files`;
    return { mode, reason, rows: [...rows], vendors: vendorTests };
  }
  const found = names([...kinds.catalog, ...kinds.pins], read);
  if (found.error) return full(found.error);
  const optional = kinds.catalog.some((file) => file.startsWith('src/packages/optional/'));
  if (optional || !kinds.pins.length) for (const name of map.catalog) rows.add(row(name));
  if (kinds.pins.length) for (const name of map.bump) rows.add(row(name));
  const own = packageRows(found.names, map, rows);
  if (own.error) return full(own.error);
  return {
    mode: kinds.pins.length ? 'bump' : 'catalog',
    reason: `${found.names.join(', ') || 'no package'} changed`,
    rows: [...rows],
    vendors: vendorTests || own.vendors,
  };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function changes(cwd = ROOT) {
  const names = git(cwd, ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'])
    .split('\n')
    .filter(Boolean);
  const read = (side, file) => {
    try {
      return git(cwd, ['show', `${side === 'base' ? 'HEAD^1' : 'HEAD'}:${file}`]);
    } catch {
      return null;
    }
  };
  return { changed: names, read };
}

export async function scopes() {
  return JSON.parse(await readFile(join(ROOT, 'scripts/ci/scopes.json'), 'utf8'));
}
