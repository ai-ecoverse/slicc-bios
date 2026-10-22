import { provenance, REGISTRY, satisfies } from './beta.js';
import {
  folder,
  installProject,
  loadProject,
  movePth,
  normalizeProject,
  projectVersion,
  removeProject,
} from './projects.js';
import { BIOS } from './site.js';
import { linkSkills, unlinkSkills } from './skills.js';
import { fetchText, pnpm, pnpmAs, text, write } from './update.js';

const deployed = new URL('packages/optional/', BIOS);
export const GLOBAL = 'home/.local/share/pnpm/global/v11';
const HOME = /^\/[^\0]*[^/]$/;
export const LISTING = 'etc/slicc/optional.json';
const RUNNING = { install: 'installing', update: 'updating', remove: 'removing' };
const LOCKED =
  /^ {2}'?((?:@[^/\s]+\/)?[^@'\s]+)@([^'(\s]+)'?:\n {4}resolution: \{integrity: ([^,}\s]+)/gm;

export const RETIRED = 'No longer offered. Remove it, or keep using it as it is.';
export const MOVED = 'var/lib/slicc/optional/moved';

const COMMAND = /^[A-Za-z0-9][\w.+-]*$/;
const UNSHADOW =
  'b=$1; o=$2; shift 2; for n in "$@"; do f="$b/$n"; [ -e "$f" ] || [ -L "$f" ] || continue; case "$(readlink -f "$f" 2>/dev/null)" in *"$o"*) ;; *) grep -qsF -- "$o" "$f" || continue ;; esac; rm -f -- "$f" || exit 1; echo "$n"; done';

export const MISMATCH =
  "This version doesn't match the tested build, so it was removed again. Retry later.";
export const kept = (user, version) =>
  `This version doesn't match the tested build, so ${user} keeps ${version}. Retry later.`;
export function foreign(entry, action, installed, owned) {
  if (action !== 'remove' || installed.has(entry.package) || !owned.has(entry.package)) return null;
  const users = owned.get(entry.package).map(({ user }) => user);
  return `${entry.label} is installed for ${users.join(' and ')} with pnpm. Remove it there with pnpm remove -g.`;
}
const LOGIN = /^[a-z_][a-z0-9_.-]*$/;
const OWN = /^\/home\/(?!\.\.?$)[^/]+$/;
const USER_FLAGS = [
  '--ignore-scripts',
  '--ignore-pnpmfile',
  '--config.verify-store-integrity=true',
  '--config.minimum-release-age=0',
];

function parts(version) {
  const [main, ...rest] = version.split('-');
  return { main: main.split('.').map(Number), pre: rest.length ? rest.join('-').split('.') : [] };
}

function compareIds(a, b) {
  const numeric = /^\d+$/.test(a) && /^\d+$/.test(b);
  if (numeric) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compare(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const d = compareIds(x.pre[i], y.pre[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

const PACKAGE = /^ {2}'?((?:@[^/\s]+\/)?[^@'\s]+)@([^'(\s]+?)(?:\([^\n]*\))?'?:$/gm;

export function installedLock(text) {
  const found = locked(text);
  const at = text.indexOf('\npackages:\n');
  const end = text.indexOf('\nsnapshots:\n', at);
  const block = at < 0 ? '' : text.slice(at, end < 0 ? text.length : end);
  for (const [, name, version] of block.matchAll(PACKAGE)) {
    const key = `${name}@${version}`;
    if (!found.has(key)) found.set(key, null);
  }
  return found;
}

export function locked(lock) {
  return new Map(
    [...lock.matchAll(LOCKED)].map(([, name, version, integrity]) => [
      `${name}@${version}`,
      integrity,
    ])
  );
}

export const CACHE = 'var/lib/slicc/optional/npm.json';
export const LIVE_EXCEPTIONS =
  'https://raw.githubusercontent.com/ai-ecoverse/homescoop/main/certification-exceptions.json';
export const HOMESCOOP = {
  repo: 'ai-ecoverse/homescoop',
  workflow: ['.github/workflows/ladder-build.yml', '.github/workflows/publish.yml'],
};
export const TIMEOUT = 15000;
const OURS = /^@ai-ecoverse\/[a-z0-9][\w.-]*$/;
const HOMESCOOPED = /^@ai-ecoverse\/(?:wasm|wasi|wasix|py)-/;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const ABBREVIATED = 'application/vnd.npm.install-v1+json';
const MAIN = ['refs/heads/main'];
export const WALK = 5;
const ENTRY_KEYS = new Set([
  'package',
  'versions',
  'range',
  'verdict',
  'requires',
  'issue',
  'ruling',
]);

const short = (name) => name.replace(/^@ai-ecoverse\//, '');
export const nameOf = (key) => key.slice(0, key.lastIndexOf('@'));
const versionOf = (key) => key.slice(key.lastIndexOf('@') + 1);
const no = (why, drift = false) => (drift ? { why, drift } : { why });

export function worded(range) {
  const at = String(range)
    .trim()
    .match(/^>=\s*v?(\S+)$/);
  return at ? `${at[1]} or newer` : String(range).trim();
}

export function within(version, range) {
  return EXACT.test(version) && satisfies(version.split('-')[0], range);
}

export function commandsOf(doc, helpers = []) {
  return Object.entries(doc?.slicc?.commands ?? {})
    .filter(([name, spec]) => COMMAND.test(name) && !spec?.helper && !helpers.includes(name))
    .map(([name]) => name);
}

export const RETRIES = [500, 1500];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gaveUp = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

async function json(fetcher, url, init = {}, { waits = [], sleep = pause } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const again = attempt < waits.length;
    let response;
    try {
      response = await fetcher(url, {
        cache: 'no-cache',
        signal: AbortSignal.timeout(TIMEOUT),
        ...init,
      });
    } catch (error) {
      if (!again || gaveUp(error)) throw error;
      await sleep(waits[attempt]);
      continue;
    }
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    if (response.status < 500 || !again) throw new Error(`${response.status} for ${url}`);
    await sleep(waits[attempt]);
  }
}

export function registry(
  fetcher = (url, init) => fetch(url, init),
  { waits = RETRIES, sleep = pause } = {}
) {
  const memo = new Map();
  const once = (url, init) => {
    if (!memo.has(url)) {
      const pending = json(fetcher, url, init, { waits, sleep });
      memo.set(url, pending);
      pending.catch(() => memo.delete(url));
    }
    return memo.get(url);
  };
  const at = (name, version) => `${REGISTRY}${name}/${encodeURIComponent(version)}`;
  const latest = async (name) => {
    const doc = await once(`${REGISTRY}${name}/latest`);
    if (typeof doc?.version === 'string' && !memo.has(at(name, doc.version)))
      memo.set(at(name, doc.version), Promise.resolve(doc));
    return doc;
  };
  return {
    version: (name, version) => once(at(name, version)),
    latest,
    packument: (name) => once(`${REGISTRY}${name}`, { headers: { accept: ABBREVIATED } }),
    attest: (url, init) => fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) }),
    exceptions: () => json(fetcher, LIVE_EXCEPTIONS),
  };
}

function invalidEntry(entry) {
  if (!entry || typeof entry !== 'object') return true;
  if (Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) return true;
  if (typeof entry.package !== 'string' || 'versions' in entry === 'range' in entry) return true;
  if ('versions' in entry && !entry.versions?.every?.((v) => typeof v === 'string')) return true;
  if ('range' in entry && typeof entry.range !== 'string') return true;
  if (!['fail', 'requires'].includes(entry.verdict)) return true;
  if (entry.verdict !== 'requires') return false;
  return typeof entry.requires !== 'object' || !Object.keys(entry.requires ?? {}).length;
}

export function exceptionsOf(file) {
  if (file?.schema !== 1 || !Array.isArray(file.entries)) return null;
  if (Object.keys(file).some((key) => key !== 'schema' && key !== 'entries')) return null;
  return file.entries.some(invalidEntry) ? null : file.entries;
}

export async function loadExceptions(bundled, npm) {
  const own = exceptionsOf(bundled);
  if (!own) throw new Error("bios's copy of homescoop's certification exceptions isn't schema 1");
  const live = await npm
    .exceptions()
    .then(exceptionsOf)
    .catch(() => null);
  return [...own, ...(live ?? [])];
}

export function ruled(exceptions, name, version, pins) {
  for (const entry of exceptions) {
    if (entry.package !== name) continue;
    const hit = entry.versions ? entry.versions.includes(version) : satisfies(version, entry.range);
    if (!hit) continue;
    const ref = entry.issue ? ` (${entry.issue})` : '';
    if (entry.verdict === 'fail') return `${short(name)} ${version} was withdrawn${ref}`;
    for (const [dep, range] of Object.entries(entry.requires)) {
      const have = [...pins].filter((key) => nameOf(key) === dep).map(versionOf);
      if (!have.length || !have.every((at) => satisfies(at, range)))
        return `${short(name)} ${version} needs ${short(dep)} ${worded(range)}${ref}`;
    }
  }
  return null;
}

export function fits(doc, have) {
  const wants = { ...doc.peerDependencies };
  if (doc.engines?.['slicc-kernel']) wants[KERNEL] = doc.engines['slicc-kernel'];
  for (const [name, range] of Object.entries(wants)) {
    const at = Object.hasOwn(have, name) ? have[name] : null;
    if (at && !satisfies(at, range)) return `needs ${short(name)} ${worded(range)}`;
  }
  return null;
}

export function sourceOf(name, sources) {
  if (Object.hasOwn(sources, name)) return sources[name];
  return HOMESCOOPED.test(name) ? HOMESCOOP : null;
}

const PROVENANCE = {
  'no integrity': (it) => `npm lists no integrity for ${it}`,
  'no provenance': (it) => `${it} has no build provenance`,
  'its provenance doesn’t match this release': (it, repo) => `${it} wasn't built by ${repo}`,
  'built outside the release workflow': (it, repo) =>
    `${it} wasn't built by ${repo}'s release workflow on main`,
};

async function published(name, version, doc, source, ctx) {
  const it = `${short(name)} ${version}`;
  if (source.certified === 'tag') {
    const tags = (await ctx.npm.packument(name))?.['dist-tags'] ?? {};
    return tags.certified === version ? null : `needs ${it}, which isn't certified`;
  }
  const memo = `${name}@${version} ${doc.dist.integrity}`;
  if (ctx.verdicts?.has(memo)) return ctx.verdicts.get(memo);
  const repository = `https://github.com/${source.repo}`;
  const found = await provenance(
    doc,
    { name, repository, workflow: source.workflow, refs: MAIN },
    ctx.npm.attest
  );
  const why = found && (PROVENANCE[found]?.(it, source.repo) ?? `${it}: ${found}`);
  if (!why) ctx.verdicts?.set(memo, null);
  return why;
}

export async function judge(key, integrity, ctx) {
  const name = nameOf(key);
  const version = versionOf(key);
  if (!integrity) return no(`${key} isn't a registry tarball with an integrity`);
  if (ctx.base.get(key) === integrity) {
    const why = ruled(ctx.exceptions, name, version, ctx.pins ?? []);
    return why ? no(why) : null;
  }
  if (!OURS.test(name)) return no(`${key} isn't one of seven's own packages`);
  const doc = await ctx.npm.version(name, version);
  if (!doc) return no(`npm doesn't have ${short(name)} ${version}`);
  if (doc.dist?.integrity !== integrity)
    return no(`${short(name)} ${version} doesn't match npm's build`, true);
  const source = sourceOf(name, ctx.sources);
  if (!source) return no(`${short(name)} has no publisher seven knows`);
  const why =
    (await published(name, version, doc, source, ctx)) ??
    ruled(ctx.exceptions, name, version, ctx.pins ?? []) ??
    fits(doc, ctx.have);
  return why ? no(why) : null;
}

async function exactDeps(doc, ctx) {
  const deps = Object.entries(doc.dependencies ?? {}).filter(([, spec]) => EXACT.test(spec));
  const found = await Promise.all(
    deps.map(async ([dep, spec]) => {
      const key = `${dep}@${spec}`;
      const depDoc = await ctx.npm.version(dep, spec);
      if (!depDoc) return no(`npm doesn't have ${short(dep)} ${spec}`);
      return judge(key, depDoc.dist?.integrity, ctx);
    })
  );
  return found.find(Boolean) ?? null;
}

async function chosen(entry, npm) {
  if (entry.pin) return npm.version(entry.package, entry.pin);
  if (!entry.range) return npm.latest(entry.package);
  const all = await npm.packument(entry.package);
  const best = Object.entries(all?.versions ?? {})
    .filter(([version, doc]) => within(version, entry.range) && !doc?.deprecated)
    .map(([version]) => version)
    .sort(compare)
    .at(-1);
  if (!best) return { none: `npm has no ${entry.label} in ${entry.range}` };
  return npm.version(entry.package, best);
}

function checked(name, doc) {
  const integrity = doc?.dist?.integrity;
  if (doc?.name !== name || !EXACT.test(doc?.version ?? '') || !INTEGRITY.test(integrity ?? ''))
    throw new Error(`npm gave no version of ${name}`);
  return doc;
}

async function refusedFor(entry, doc, ctx) {
  const key = `${entry.package}@${doc.version}`;
  if (entry.abi && doc.slicc?.python?.abi !== entry.abi)
    return no(`${short(entry.package)} ${doc.version} isn't built for ${entry.abi}`);
  const pinned = { ...ctx, pins: [key, ...(ctx.shipped ?? ctx.base).keys()] };
  return (await judge(key, doc.dist.integrity, pinned)) ?? (await exactDeps(doc, pinned));
}

async function older(entry, latest, ctx) {
  const all = await ctx.npm.packument(entry.package);
  const candidates = Object.entries(all?.versions ?? {})
    .filter(([version, doc]) => EXACT.test(version) && !doc?.deprecated)
    .filter(([version]) => compare(version, latest) < 0)
    .filter(([version]) => !entry.range || within(version, entry.range))
    .map(([version]) => version)
    .sort(compare)
    .reverse()
    .slice(0, WALK);
  for (const version of candidates) {
    const doc = await ctx.npm.version(entry.package, version).catch(() => null);
    const valid = doc?.name === entry.package && INTEGRITY.test(doc?.dist?.integrity ?? '');
    if (valid && !(await refusedFor(entry, doc, ctx))) return doc;
  }
  return null;
}

function infoOf(entry, doc) {
  const size = doc.dist.unpackedSize;
  return {
    version: doc.version,
    integrity: doc.dist.integrity,
    description: typeof doc.description === 'string' ? doc.description : '',
    commands: commandsOf(doc, entry.helpers),
    ...(Number.isInteger(size) && size > 0 ? { size } : {}),
  };
}

export async function look(entry, ctx) {
  const found = await chosen(entry, ctx.npm);
  if (found?.none) return { version: null, withheld: found.none };
  const doc = checked(entry.package, found);
  const refused = await refusedFor(entry, doc, ctx);
  if (!refused) return infoOf(entry, doc);
  const fallback = entry.pin ? null : await older(entry, doc.version, ctx).catch(() => null);
  const newer = { version: doc.version, reason: refused.why };
  if (fallback) return { ...infoOf(entry, fallback), newer };
  return { ...infoOf(entry, doc), withheld: refused.why };
}

export function collided(entries, infos) {
  const owners = new Map();
  const found = new Map();
  entries.forEach((entry, i) => {
    const info = infos[i];
    const taken = (info?.commands ?? []).find((command) => owners.has(command));
    for (const command of info?.commands ?? [])
      if (!owners.has(command)) owners.set(command, entry);
    const why = taken && `its ${taken} command is ${owners.get(taken).label}'s`;
    found.set(entry.package, why && !info.withheld ? { ...info, withheld: why } : info);
  });
  return found;
}

export function createNpm({ base, shipped = base, sources, bundled, have, fetcher }) {
  const context = async (verdicts = null) => {
    const npm = registry(fetcher);
    const exceptions = await loadExceptions(bundled, npm);
    return { npm, base, shipped, sources, have, verdicts, exceptions };
  };

  async function lookAll(entries, verdicts) {
    const ctx = await context(verdicts);
    const looked = await Promise.allSettled(entries.map((entry) => look(entry, ctx)));
    return collided(
      entries,
      entries.map((_, i) => (looked[i].status === 'fulfilled' ? looked[i].value : null))
    );
  }

  async function gate(lock, key) {
    if (!lock.has(key)) return no(`pnpm didn't install ${short(nameOf(key))} ${versionOf(key)}`);
    const ctx = await context();
    ctx.pins = [...lock.keys(), ...shipped.keys()];
    const found = await Promise.all(
      [...lock].map(([one, integrity]) =>
        judge(one, integrity, ctx).catch((error) =>
          no(`couldn't check ${one} on npm (${error.message.split('\n')[0]})`)
        )
      )
    );
    return found.find(Boolean) ?? null;
  }

  async function denied(keys, lock) {
    const ctx = await context();
    const pins = [...lock.keys(), ...shipped.keys()];
    return keys.filter((key) => ruled(ctx.exceptions, nameOf(key), versionOf(key), pins));
  }

  async function admitted(left, lock, names) {
    const ctx = await context();
    ctx.pins = [...lock.keys(), ...shipped.keys()];
    const ok = new Set();
    for (const [key, integrity] of left) {
      if (!names.has(nameOf(key))) continue;
      if (await judge(key, integrity, ctx).catch(() => no('unreachable'))) continue;
      ok.add(key);
      const doc = await ctx.npm.version(nameOf(key), versionOf(key));
      for (const [dep, spec] of Object.entries(doc?.dependencies ?? {})) {
        const at = `${dep}@${spec}`;
        if (!lock.has(at) || ok.has(at)) continue;
        if (!(await judge(at, lock.get(at), ctx).catch(() => no('unreachable')))) ok.add(at);
      }
    }
    return ok;
  }

  async function offer(entry) {
    return look(entry, await context());
  }

  return { lookAll, gate, admitted, denied, offer };
}

export async function readCache(root) {
  try {
    const found = JSON.parse((await text(root, CACHE)) ?? 'null');
    if (found?.schema !== 1) throw new Error('no cache');
    return new Map(Object.entries(found.entries ?? {}));
  } catch {
    return new Map();
  }
}

export function writeCache(root, entries) {
  const data = { schema: 1, entries: Object.fromEntries(entries) };
  return write(root, CACHE, `${JSON.stringify(data)}\n`);
}

const KERNEL = '@ai-ecoverse/slicc-kernel';

function lockKeys(lock) {
  const found = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    found.set(`${name}@${entry.version}`, entry.integrity);
  }
  return found;
}

export async function loadCatalog(from = deployed, { fetcher } = {}) {
  const read = async (name) => JSON.parse(await fetchText(name, from));
  const [catalog, base, bundled, extra, certs, manifest, lock] = await Promise.all([
    read('catalog.json'),
    read('../package-lock.json'),
    read('exceptions.json'),
    read('sources.json').catch(() => ({})),
    read('../certs.json').catch(() => ({})),
    read('package.json').catch(() => ({})),
    read('package-lock.json').catch(() => ({})),
  ]);
  const shipped = lockKeys(base);
  const certified = new Map();
  for (const [key, { integrity }] of Object.entries(certs))
    if (typeof integrity === 'string') certified.set(key, integrity);
  for (const [key, integrity] of shipped) certified.set(key, integrity);
  for (const [key, integrity] of lockKeys(lock)) certified.set(key, integrity);
  const pins = manifest.dependencies ?? {};
  const sources = { ...extra };
  for (const [name, entry] of Object.entries(catalog))
    if (entry.source && entry.kind !== 'project') sources[name] = entry.source;
  const entries = await Promise.all(
    Object.entries(catalog).map(async ([name, entry]) => {
      if (entry.kind !== 'project') {
        const pin = Object.hasOwn(pins, name) ? { pin: pins[name] } : {};
        return { ...entry, ...pin, package: name, requires: entry.requires ?? [], offered: null };
      }
      const project = await loadProject(entry.id, from);
      return {
        ...entry,
        package: project.name,
        requires: entry.requires ?? [],
        offered: project.version,
        project,
      };
    })
  );
  const gone = await fetchText('retired.json', from)
    .then(JSON.parse)
    .catch(() => ({}));
  const retired = Object.entries(gone).map(([name, entry]) => ({
    ...entry,
    package: name,
    description: RETIRED,
    requires: [],
    offered: null,
    retired: true,
  }));
  const have = { [KERNEL]: base.packages?.[`node_modules/${KERNEL}`]?.version ?? null };
  const npm = createNpm({ base: certified, shipped, sources, bundled, have, fetcher });
  return { entries, certified, retired, npm };
}

export function withNpm(entry, info, registry = 'checking') {
  if (entry.kind === 'project' || entry.retired) return entry;
  if (!info) return { ...entry, description: '', commands: [], offered: null, registry };
  return {
    ...entry,
    description: info.description ?? '',
    commands: info.commands ?? [],
    offered: info.withheld ? null : info.version,
    ...(info.withheld && info.version ? { latest: info.version } : {}),
    ...(info.size ? { size: info.size, unpacked: true } : {}),
    ...(info.withheld ? { withheld: info.withheld } : {}),
    ...(info.newer ? { newer: info.newer } : {}),
  };
}

async function directories(dir, path) {
  try {
    for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part);
  } catch {
    return [];
  }
  const found = [];
  for await (const handle of dir.values()) {
    if (handle.kind === 'directory') found.push(handle.name);
  }
  return found.sort();
}

export async function globalDir(kernel) {
  let out = '';
  const { status } = await kernel.run(['bash', '-c', 'printf %s "$PNPM_HOME"'], {
    cwd: '/',
    onStdout: (chunk) => {
      out += chunk;
    },
  });
  return status === 0 && HOME.test(out) ? `${out.slice(1)}/global/v11` : GLOBAL;
}

export async function globals(root, dir = GLOBAL) {
  const found = [];
  for (const name of await directories(root, dir)) {
    const at = `${dir}/${name}`;
    const manifest = JSON.parse((await text(root, `${at}/package.json`)) ?? '{}');
    const lock = installedLock((await text(root, `${at}/pnpm-lock.yaml`)) ?? '');
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const installed = JSON.parse(
        (await text(root, `${at}/node_modules/${dependency}/package.json`)) ?? '{}'
      );
      if (installed.version)
        found.push({ name: dependency, version: installed.version, lock, dir: at });
    }
  }
  return found;
}

export function homes(passwd) {
  return (passwd ?? '')
    .split('\n')
    .map((line) => line.split(':'))
    .filter(
      ([name, , uid, , , home]) => LOGIN.test(name) && Number(uid) > 0 && OWN.test(home ?? '')
    )
    .map(([name, , , , , home]) => ({ user: name, home }));
}

export async function userGlobals(root) {
  const found = [];
  for (const { user, home } of homes(await text(root, 'etc/passwd'))) {
    const where = `${home}/.local/share/pnpm`;
    for (const install of await globals(root, `${where.slice(1)}/global/v11`))
      found.push({ ...install, user, home, where });
  }
  return found;
}

export function byUser(found) {
  const owned = new Map();
  for (const install of found) {
    const list = owned.get(install.name) ?? [];
    const same = list.find(({ user }) => user === install.user);
    if (same && compare(install.version, same.version) <= 0) continue;
    owned.set(install.name, [...list.filter(({ user }) => user !== install.user), install]);
  }
  return owned;
}

const newest = (installs) =>
  installs.reduce(
    (best, { version }) => (best === null || compare(version, best) > 0 ? version : best),
    null
  );

export function shadowed(manifest) {
  const bin =
    typeof manifest?.bin === 'string'
      ? { [String(manifest.name).split('/').pop()]: manifest.bin }
      : (manifest?.bin ?? {});
  return Object.keys(manifest?.slicc?.commands ?? {}).filter(
    (name) => COMMAND.test(name) && Object.hasOwn(bin, name)
  );
}

export function binDir(global) {
  return `/${global.replace(/\/global\/v\d+$/, '')}/bin`;
}

let unshadowing = Promise.resolve();

export function unshadow(options) {
  const next = unshadowing.then(() => unshadowOnce(options));
  unshadowing = next.catch(() => undefined);
  return next;
}

async function unshadowOnce({ root, kernel, global, name, dir, user = 'root' }) {
  const manifest = JSON.parse(
    (await text(root, `${dir}/node_modules/${name}/package.json`)) ?? '{}'
  );
  const names = shadowed(manifest);
  if (!names.length) return [];
  const owner = `/node_modules/${name}/`;
  let out = '';
  const { status, stderr } = await kernel.run(
    ['bash', '-c', UNSHADOW, 'unshadow', binDir(global), owner, ...names],
    {
      cwd: '/',
      user,
      onStdout: (chunk) => {
        out += chunk;
      },
    }
  );
  if (status)
    throw new Error(stderr?.trim() || `unlinking ${names.join(', ')} exited with ${status}`);
  return out.split('\n').filter(Boolean);
}

const PASSWD = '/etc/passwd';
const SHELL_HOME = /^\/home\/[^/]+\/\.local\/share\/pnpm(?=\/(?:bin|global)(?:\/|$))/;

export function pnpmHome(path, system) {
  if (path === `${system}/bin` || path.startsWith(`${system}/bin/`)) return system;
  if (path === `${system}/global` || path.startsWith(`${system}/global/`)) return system;
  return SHELL_HOME.exec(path)?.[0] ?? null;
}

export async function shellUnshadow({ root, kernel, global, home }) {
  const system = binDir(global).slice(0, -'/bin'.length);
  const owner =
    home === system
      ? { user: 'root', global }
      : homes(await text(root, 'etc/passwd'))
          .filter((found) => home === `${found.home}/.local/share/pnpm`)
          .map(({ user }) => ({ user, global: `${home.slice(1)}/global/v11` }))[0];
  if (!owner) return [];
  const removed = [];
  for (const { name, dir } of await globals(root, owner.global))
    removed.push(...(await unshadow({ root, kernel, name, dir, ...owner })));
  return removed;
}

export async function watchShadows({ root, kernel, attach, global, wait = 50, report }) {
  const system = binDir(global).slice(0, -'/bin'.length);
  const client = await attach(await kernel.connect());
  const timers = new Map();
  const pass = (home) => {
    timers.delete(home);
    void shellUnshadow({ root, kernel, global, home }).catch((error) =>
      report(`unshadow ${home}: ${error.message}`)
    );
  };
  const all = async () => [
    system,
    ...homes(await text(root, 'etc/passwd')).map(({ home }) => `${home}/.local/share/pnpm`),
  ];
  const onChange = ({ paths, overflow }) => {
    if (overflow || paths.includes(PASSWD))
      void rewatch().catch((error) => report(`unshadow watch: ${error.message}`));
    const found = overflow ? all() : paths.map((path) => pnpmHome(path, system));
    void Promise.resolve(found).then((list) => {
      for (const home of new Set(list.filter(Boolean))) {
        clearTimeout(timers.get(home));
        timers.set(
          home,
          setTimeout(() => pass(home), wait)
        );
      }
    });
  };
  let watching = null;
  let watched = '';
  let chain = Promise.resolve();
  const rewatch = () => {
    const next = chain.then(async () => {
      const paths = [PASSWD, ...(await all()).flatMap((home) => [`${home}/bin`, `${home}/global`])];
      if (paths.join('\n') === watched) return;
      const before = watching;
      watching = await client.fs.watch(paths, { recursive: true }, onChange);
      watched = paths.join('\n');
      before?.close();
    });
    chain = next.catch(() => undefined);
    return next;
  };
  await rewatch();
  for (const home of await all()) pass(home);
  return {
    paths: () => watched.split('\n'),
    close: () => chain.then(() => watching.close()),
  };
}

export function refusal(refused, label, previous) {
  if (refused.drift && !previous) return MISMATCH;
  if (refused.drift)
    return `This version doesn't match the tested build, so ${label} ${previous} stays. Retry later.`;
  return `Not offered: ${refused.why}.${previous ? ` ${label} ${previous} stays.` : ''}`;
}

function refusedError(key, refused, label, previous) {
  return Object.assign(new Error(`${key} failed the gate: ${refused.why}`), {
    plain: refusal(refused, label, previous),
  });
}

export function writeListing(root, entries) {
  const listing = entries.map(
    ({ id, package: name, offered, label, description, commands, requires }) => ({
      id,
      package: name,
      ...(offered ? { version: offered } : {}),
      label,
      ...(description ? { description } : {}),
      commands,
      requires,
    })
  );
  return write(root, LISTING, `${JSON.stringify(listing, null, 2)}\n`);
}

function plain(action, label, error) {
  if (error.plain) return error.plain;
  const verb = action === 'remove' ? 'remove' : action === 'update' ? 'update' : 'install';
  return `Couldn't ${verb} ${label}: pnpm stopped with an error, shown in the install log. Retry.`;
}

const OPTIONAL = ['notes', 'unpacked', 'registry', 'withheld', 'newer'];

function fields(entry) {
  const found = {};
  for (const key of OPTIONAL) {
    const value = entry[key];
    if (Array.isArray(value) ? value.length : value) found[key] = value;
  }
  return found;
}

function availableActions(entry) {
  if (entry.offered) return ['install'];
  return entry.registry === 'unreachable' ? ['retry'] : [];
}

function held(entry, version) {
  if (version === null) return entry;
  if (entry.newer && entry.offered && compare(entry.offered, version) < 0)
    return { ...entry, offered: version };
  if (!entry.withheld) return entry;
  const { withheld, latest, ...rest } = entry;
  const ahead = latest && compare(latest, version) > 0;
  return {
    ...rest,
    offered: version,
    ...(ahead ? { newer: { version: latest, reason: withheld } } : {}),
  };
}

export function describe(listed, panel, running, installs = []) {
  const theirs = panel === null && installs.length > 0;
  const version = theirs ? newest(installs) : panel;
  const entry = held(listed, version);
  const outdated =
    version !== null && !entry.retired && !!entry.offered && compare(entry.offered, version) > 0;
  const base = {
    id: entry.id,
    package: entry.package,
    label: entry.label,
    description: entry.description,
    commands: entry.commands,
    requires: entry.requires,
    version,
    installs,
    offered: entry.offered,
    size: entry.size,
    ...fields(entry),
    progress: null,
    error: null,
  };
  if (running?.state === 'failed') {
    return {
      ...base,
      state: 'failed',
      error: running.error,
      log: running.log,
      actions: version === null || theirs ? ['retry'] : ['retry', 'remove'],
    };
  }
  if (running) return { ...base, ...running, actions: [] };
  if (version === null) return { ...base, state: 'available', actions: availableActions(entry) };
  if (theirs)
    return {
      ...base,
      state: outdated ? 'outdated' : 'installed',
      actions: outdated ? ['update'] : [],
    };
  if (entry.retired) return { ...base, state: 'installed', actions: ['remove'] };
  if (outdated) return { ...base, state: 'outdated', actions: ['update', 'remove'] };
  return { ...base, state: 'installed', actions: ['remove'] };
}

async function panelVersions({ root, kernel, entries, retired, found }) {
  const installed = new Map();
  for (const { name, version } of found) {
    const before = installed.get(name);
    if (!before || compare(version, before) > 0) installed.set(name, version);
  }
  for (const entry of entries.filter((entry) => entry.kind === 'project')) {
    const version = await projectVersion(root, entry.id);
    if (version) installed.set(entry.package, version);
    if (version) await movePth(root, entry.id);
    if (version) await normalizeProject(root, kernel, entry.id);
  }
  for (const entry of retired.filter((entry) => entry.kind === 'project')) {
    const version = await projectVersion(root, entry.id);
    if (version) installed.set(entry.package, version);
  }
  return installed;
}

export function installsOf(entry, { installed, owned, global }) {
  const where =
    entry.kind === 'project' ? `/${folder(entry.id)}` : `/${global.replace(/\/global\/v\d+$/, '')}`;
  return [
    ...(installed.has(entry.package)
      ? [{ version: installed.get(entry.package), where, manager: 'panel' }]
      : []),
    ...(owned.get(entry.package) ?? []).map(({ version, where, user }) => ({
      version,
      where,
      user,
      manager: 'pnpm',
    })),
  ];
}

export function satisfied(entry, needed, installed, owned) {
  if (installed.has(needed.package)) return true;
  if (installed.has(entry.package)) return false;
  const theirs = new Set((owned.get(needed.package) ?? []).map(({ user }) => user));
  const users = (owned.get(entry.package) ?? []).map(({ user }) => user);
  return users.length > 0 && users.every((user) => theirs.has(user));
}

function needs(entry, needed, installed) {
  const version = installed.get(needed.package);
  if (version === undefined) return 'install';
  if (entry.kind === 'project' && !needed.retired && !needed.offered) return 'unknown';
  return entry.kind === 'project' &&
    !needed.retired &&
    needed.offered &&
    compare(needed.offered, version) > 0
    ? 'update'
    : null;
}

export async function updateFor({ kernel, entry, gate, owned, start, rescan }) {
  const key = `${entry.package}@${entry.offered}`;
  const stale = (owned.get(entry.package) ?? []).filter(
    ({ version }) => compare(entry.offered, version) > 0
  );
  for (const install of stale) {
    const report = start();
    const add = (to) =>
      pnpmAs(kernel, install, report, to, [
        'pnpm',
        'add',
        '-g',
        `${entry.package}@${to}`,
        ...USER_FLAGS,
      ]);
    await add(entry.offered);
    const now = ((await rescan()).get(entry.package) ?? []).find(
      ({ user }) => user === install.user
    );
    const refused =
      now?.version === entry.offered
        ? await gate(now.lock, key)
        : { why: `pnpm didn't install ${entry.label} ${entry.offered}` };
    if (!refused) continue;
    await add(install.version).catch(() => undefined);
    throw Object.assign(new Error(`${key} failed the gate for ${install.user}: ${refused.why}`), {
      plain: refused.drift
        ? kept(install.user, install.version)
        : `Not offered: ${refused.why}. ${install.user} keeps ${install.version}.`,
    });
  }
}

export const CHECK_EVERY = 10 * 60 * 1000;

async function judged(npm, mine, key) {
  if (!mine.length) return { why: `pnpm didn't install ${key}` };
  for (const { lock } of mine) {
    const refused = await npm.gate(lock, key);
    if (refused) return refused;
  }
  return null;
}

export async function offeredNow(npm, entry) {
  const { withheld, newer, latest, registry, ...listed } = entry;
  const info = await npm.offer(listed).catch(() => null);
  const live = withNpm(listed, info, 'unreachable');
  if (!live.offered) throw unoffered(live);
  return live;
}

async function freshFor(npm, listed, action) {
  if (listed.kind === 'project' || action === 'remove') return listed;
  if (!listed.offered) throw unoffered(listed);
  return offeredNow(npm, listed);
}

function unoffered(entry) {
  return Object.assign(new Error(`${entry.package} is not offered`), {
    plain: entry.withheld
      ? `Not offered: ${entry.withheld}.`
      : `Couldn't reach npm for ${entry.label}'s version. Retry.`,
  });
}

function removable(entries, entry, present, ask) {
  const users = entries.filter(
    (other) => other.requires.includes(entry.id) && present(other.package)
  );
  if (!users.length) return true;
  const one = users.length === 1;
  return ask({
    title: `Remove ${entry.label}?`,
    body: `${users.map((other) => other.label).join(' and ')} ${one ? 'needs' : 'need'} it and ${one ? 'stops' : 'stop'} working until ${entry.label} is back.`,
    action: 'Remove',
    variant: 'confirmation',
  });
}

function npmListing({ catalog, root, changed }) {
  const { entries: listed, retired = [], npm } = catalog;
  let found = new Map();
  const verdicts = new Map();
  let reached = 'checking';
  let checked = 0;
  let checking = null;
  let again = null;
  const state = { entries: listed, byId: new Map() };
  const merge = () => {
    state.entries = listed.map((entry) => withNpm(entry, found.get(entry.package), reached));
    state.byId = new Map([...retired, ...state.entries].map((entry) => [entry.id, entry]));
  };
  merge();

  async function load() {
    found = await readCache(root);
    merge();
    await writeListing(root, state.entries);
  }

  async function fetchNpm() {
    reached = 'checking';
    merge();
    changed();
    const wanted = listed.filter((entry) => entry.kind !== 'project');
    const looked = await npm.lookAll(wanted, verdicts).catch(() => new Map());
    const next = new Map(found);
    for (const [name, info] of looked) if (info) next.set(name, info);
    found = next;
    reached = 'unreachable';
    checked = Date.now();
    merge();
    changed();
    await writeCache(root, found).catch(() => undefined);
    await writeListing(root, state.entries).catch(() => undefined);
  }

  function check({ force = false } = {}) {
    if (!force && checked && Date.now() - checked < CHECK_EVERY) return Promise.resolve();
    if (checking && force) {
      again ??= checking.then(() => {
        again = null;
        return check({ force: true });
      });
      return again;
    }
    checking ??= fetchNpm().finally(() => {
      checking = null;
    });
    return checking;
  }

  let loaded = null;
  let first = null;
  const ready = () => {
    loaded ??= load().catch(() => undefined);
    const later = loaded.then(() => check()).catch(() => undefined);
    first ??= later;
    return first;
  };

  return { state, ready, check };
}

function missingOf(entry, byId, installed, owned) {
  return entry.requires
    .map((id) => byId.get(id))
    .filter((needed) => needed && !satisfied(entry, needed, installed, owned))
    .map(
      (needed) =>
        `Needs ${needed.label}, which isn't installed. Install ${needed.label} again to use it.`
    );
}

export async function install(entry, byId, panel, { remove, add, restore }) {
  const gone = (entry.replaces ?? [])
    .map((name) => [...byId.values()].find((one) => one.package === name))
    .filter((old) => old && panel.has(old.package))
    .map((old) => ({ old, version: panel.get(old.package) }));
  for (const { old } of gone) await remove(old);
  try {
    await add();
  } catch (error) {
    for (const { old, version } of gone) await restore(old, version).catch(() => undefined);
    throw error;
  }
  return gone.map(({ old }) => old);
}

export function replacer(attempt, run, live, changed) {
  return {
    remove: (old) => attempt(old, 'remove'),
    restore: (old, version) =>
      run(old, 'install', ['pnpm', 'add', '-g', `${old.package}@${version}`]).finally(() => {
        live.delete(old.id);
        changed();
      }),
  };
}

export function createPackages({ catalog, root, kernel, ask, emit, global = GLOBAL }) {
  const { retired = [], npm } = catalog;
  const { state, ready, check } = npmListing({ catalog, root, changed: () => changed() });
  const live = new Map();
  let [installed, owned] = [new Map(), new Map()];
  const users = Boolean(kernel?.users) && kernel.users.mode !== 'off';
  const present = (name) => installed.has(name) || owned.has(name);

  const missing = (entry) => missingOf(entry, state.byId, installed, owned);
  const item = (entry) => {
    const described = describe(
      entry,
      installed.get(entry.package) ?? null,
      live.get(entry.id),
      installsOf(entry, { installed, owned, global })
    );
    const warnings = described.version === null ? [] : missing(entry);
    return warnings.length ? { ...described, warnings } : described;
  };

  const list = () => [
    ...state.entries.map(item),
    ...retired.filter((entry) => present(entry.package) || live.has(entry.id)).map(item),
  ];
  const changed = () => emit(list());

  async function refresh() {
    await ready();
    const globalsFound = await globals(root, global);
    owned = byUser(users ? await userGlobals(root) : []);
    const { entries } = state;
    installed = await panelVersions({ root, kernel, entries, retired, found: globalsFound });
    changed();
    return globalsFound;
  }

  const reporter =
    (entry, action) =>
    ({ progress, log }) => {
      live.set(entry.id, {
        state: RUNNING[action],
        progress: progress && (progress.total > 1 || progress.bytes) ? progress : null,
        log: `${entry.package}@${entry.offered}\n${log}`,
      });
      changed();
    };

  async function run(entry, action, argv) {
    live.set(entry.id, { state: RUNNING[action], progress: null, log: '' });
    changed();
    await pnpm(kernel, '/home', reporter(entry, action), entry.offered, argv, false);
  }

  async function project(entry, action) {
    live.set(entry.id, { state: RUNNING[action], progress: null, log: '' });
    changed();
    if (action === 'remove') return removeProject(root, entry.id);
    await installProject({
      root,
      kernel,
      id: entry.id,
      project: entry.project,
      report: reporter(entry, action),
      to: entry.offered,
    });
  }

  async function add(entry, action) {
    const previous = action === 'update' ? (installed.get(entry.package) ?? null) : null;
    await run(entry, action, ['pnpm', 'add', '-g', `${entry.package}@${entry.offered}`]);
    const key = `${entry.package}@${entry.offered}`;
    const mine = (await refresh()).filter(
      ({ name, lock }) => name === entry.package && lock.has(key)
    );
    const refused = await judged(npm, mine, key);
    if (refused) {
      const removal = ['pnpm', 'remove', '-g', entry.package];
      const back = previous ? ['pnpm', 'add', '-g', `${entry.package}@${previous}`] : removal;
      await run(entry, previous ? 'update' : 'remove', back).catch(() =>
        run(entry, 'remove', removal)
      );
      throw refusedError(key, refused, entry.label, previous);
    }
    await unshadow({ root, kernel, global, name: entry.package, dir: mine[0].dir });
    await linkSkills({ root, kernel, global, entry, dir: mine[0].dir });
  }

  const swap = (entry, next) =>
    install(entry, state.byId, installed, { ...replacer(attempt, run, live, changed), add: next });

  async function perform(listed, action) {
    const entry = await freshFor(npm, listed, action);
    if (action === 'update' && entry.kind !== 'project' && !installed.has(entry.package)) {
      const start = () => {
        live.set(entry.id, { state: RUNNING.update, progress: null, log: '' });
        changed();
        return reporter(entry, 'update');
      };
      const rescan = () => refresh().then(() => owned);
      return swap(entry, () => updateFor({ kernel, entry, gate: npm.gate, owned, start, rescan }));
    }
    if (entry.kind === 'project' && action === 'remove') return project(entry, action);
    if (action === 'remove') {
      await run(entry, action, ['pnpm', 'remove', '-g', entry.package]);
      return unlinkSkills({ kernel, entry });
    }
    for (const id of entry.requires) {
      const needed = state.byId.get(id);
      if (!needed) continue;
      const step = needs(entry, needed, installed);
      if (!step) continue;
      if (step === 'unknown')
        throw Object.assign(new Error(`${needed.package} has no offer`), {
          plain: `Couldn't check ${needed.label}'s version on npm, which ${entry.label} needs. Retry.`,
        });
      await attempt(needed, step).catch((error) => {
        throw Object.assign(error, {
          plain: `Couldn't ${step} ${needed.label}, which ${entry.label} needs. Retry.`,
        });
      });
    }
    if (entry.kind === 'project') return project(entry, action);
    await swap(entry, () => add(entry, action));
  }

  async function attempt(entry, action) {
    try {
      await perform(entry, action);
      live.delete(entry.id);
    } catch (error) {
      const log = [live.get(entry.id)?.log, error.log, error.message].filter(Boolean).join('\n');
      live.set(entry.id, {
        state: 'failed',
        action,
        error: plain(action, entry.label, error),
        log,
      });
      throw error;
    }
  }

  async function act(id, requested) {
    if (requested === 'refresh') return check({ force: true });
    if (state.entries.some((one) => one.registry === 'checking'))
      await check().catch(() => undefined);
    const entry = state.byId.get(id);
    if (!entry) throw new Error(`${id} is not an optional package`);
    if (requested === 'retry' && entry.registry && !live.has(id)) return check({ force: true });
    const action = requested === 'retry' ? (live.get(id)?.action ?? 'install') : requested;
    if (entry.retired && action !== 'remove')
      throw new Error(`${entry.label} is no longer offered.`);
    const refused = foreign(entry, action, installed, owned);
    if (refused) throw new Error(refused);
    live.set(id, { state: 'queued', progress: null });
    changed();
    let failed = null;
    try {
      await navigator.locks.request('slicc-optional', async () => {
        if (action === 'remove') {
          await refresh();
          if (!(await removable(state.entries, entry, present, ask))) {
            live.delete(id);
            return;
          }
        }
        await attempt(entry, action);
      });
    } catch (error) {
      failed = error;
    }
    await refresh().catch(changed);
    if (failed) throw new Error(live.get(id).error);
  }

  const api = { list, refresh, act, check };
  const move = (legacy) =>
    check().then(() => moveFrom({ root, global, entries: state.entries, packages: api, legacy }));
  return { ...api, move };
}

export async function moveFrom({ root, global, entries, packages, legacy = GLOBAL }) {
  if (legacy === global || (await text(root, MOVED)) !== null) return [];
  const old = await globals(root, legacy);
  if (!old.length) return [];
  const present = new Set(
    packages
      .list()
      .filter(({ installs = [] }) => installs.some(({ manager }) => manager === 'panel'))
      .map(({ id }) => id)
  );
  const wanted = entries
    .filter((entry) => old.some(({ name }) => name === entry.package))
    .filter((entry) => !present.has(entry.id));
  if (wanted.some((entry) => entry.registry)) return [];
  const ids = wanted.map((entry) => entry.id);
  for (const id of ids) await packages.act(id, 'install').catch(() => undefined);
  await write(
    root,
    MOVED,
    `${JSON.stringify(old.map(({ name, version }) => `${name}@${version}`))}\n`
  );
  return ids;
}
