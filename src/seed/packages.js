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

export function locked(lock) {
  return new Map(
    [...lock.matchAll(LOCKED)].map(([, name, version, integrity]) => [
      `${name}@${version}`,
      integrity,
    ])
  );
}

export async function loadCatalog(from = deployed) {
  const [catalog, manifest, lock, base] = await Promise.all(
    ['catalog.json', 'package.json', 'package-lock.json', '../package-lock.json'].map(
      async (name) => JSON.parse(await fetchText(name, from))
    )
  );
  const certified = new Map();
  for (const { packages = {} } of [base, lock]) {
    for (const [path, entry] of Object.entries(packages)) {
      if (!path) continue;
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      certified.set(`${name}@${entry.version}`, entry.integrity);
    }
  }
  const entries = await Promise.all(
    Object.entries(catalog).map(async ([name, entry]) => {
      if (entry.kind !== 'project') {
        return {
          ...entry,
          package: name,
          requires: entry.requires ?? [],
          offered: manifest.dependencies[name],
        };
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
  return { entries, certified, retired };
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
    const lock = locked((await text(root, `${at}/pnpm-lock.yaml`)) ?? '');
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

export async function unshadow({ root, kernel, global, name, dir }) {
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
      onStdout: (chunk) => {
        out += chunk;
      },
    }
  );
  if (status)
    throw new Error(stderr?.trim() || `unlinking ${names.join(', ')} exited with ${status}`);
  return out.split('\n').filter(Boolean);
}

export function tested(lock, certified, key) {
  return (
    lock.has(key) && [...lock].every(([locked, integrity]) => certified.get(locked) === integrity)
  );
}

export function writeListing(root, entries) {
  const listing = entries.map(
    ({ id, package: name, offered, label, description, commands, requires }) => ({
      id,
      package: name,
      version: offered,
      label,
      description,
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

export function describe(entry, panel, running, installs = []) {
  const theirs = panel === null && installs.length > 0;
  const version = theirs ? newest(installs) : panel;
  const outdated = version !== null && !entry.retired && compare(entry.offered, version) > 0;
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
  if (version === null) return { ...base, state: 'available', actions: ['install'] };
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
  return entry.kind === 'project' && !needed.retired && compare(needed.offered, version) > 0
    ? 'update'
    : null;
}

export async function updateFor({ kernel, entry, certified, owned, start, rescan }) {
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
    if (now?.version === entry.offered && tested(now.lock, certified, key)) continue;
    await add(install.version).catch(() => undefined);
    throw Object.assign(new Error(`${key} failed the integrity check for ${install.user}`), {
      plain: kept(install.user, install.version),
    });
  }
}

export function createPackages({ catalog, root, kernel, ask, emit, global = GLOBAL }) {
  const { entries, certified, retired = [] } = catalog;
  const byId = new Map([...retired, ...entries].map((entry) => [entry.id, entry]));
  const live = new Map();
  let installed = new Map();
  let owned = new Map();
  const users = Boolean(kernel?.users) && kernel.users.mode !== 'off';
  const present = (name) => installed.has(name) || owned.has(name);

  const missing = (entry) =>
    entry.requires
      .map((id) => byId.get(id))
      .filter((needed) => needed && !satisfied(entry, needed, installed, owned))
      .map(
        (needed) =>
          `Needs ${needed.label}, which isn't installed. Install ${needed.label} again to use it.`
      );
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
    ...entries.map(item),
    ...retired.filter((entry) => present(entry.package) || live.has(entry.id)).map(item),
  ];
  const changed = () => emit(list());

  async function refresh() {
    const found = await globals(root, global);
    owned = byUser(users ? await userGlobals(root) : []);
    installed = await panelVersions({ root, kernel, entries, retired, found });
    changed();
    return found;
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
    await run(entry, action, ['pnpm', 'add', '-g', `${entry.package}@${entry.offered}`]);
    const found = await refresh();
    const key = `${entry.package}@${entry.offered}`;
    const mine = found.filter(({ name, version }) => `${name}@${version}` === key);
    if (!mine.length || mine.some(({ lock }) => !tested(lock, certified, key))) {
      await run(entry, 'remove', ['pnpm', 'remove', '-g', entry.package]);
      throw Object.assign(
        new Error(`${entry.package}@${entry.offered} failed the integrity check`),
        {
          plain: MISMATCH,
        }
      );
    }
    await unshadow({ root, kernel, global, name: entry.package, dir: mine[0].dir });
    await linkSkills({ root, kernel, global, entry, dir: mine[0].dir });
  }

  async function perform(entry, action) {
    if (action === 'update' && entry.kind !== 'project' && !installed.has(entry.package)) {
      const start = () => {
        live.set(entry.id, { state: RUNNING.update, progress: null, log: '' });
        changed();
        return reporter(entry, 'update');
      };
      const rescan = () => refresh().then(() => owned);
      return updateFor({ kernel, entry, certified, owned, start, rescan });
    }
    if (entry.kind === 'project' && action === 'remove') return project(entry, action);
    if (action === 'remove') {
      await run(entry, action, ['pnpm', 'remove', '-g', entry.package]);
      return unlinkSkills({ kernel, entry });
    }
    for (const id of entry.requires) {
      const needed = byId.get(id);
      if (!needed) continue;
      const step = needs(entry, needed, installed);
      if (!step) continue;
      await attempt(needed, step).catch((error) => {
        throw Object.assign(error, {
          plain: `Couldn't ${step} ${needed.label}, which ${entry.label} needs. Retry.`,
        });
      });
    }
    if (entry.kind === 'project') return project(entry, action);
    await add(entry, action);
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

  function removable(entry) {
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

  async function act(id, requested) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`${id} is not an optional package`);
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
          if (!(await removable(entry))) {
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

  const api = { list, refresh, act };
  return { ...api, move: (legacy) => moveFrom({ root, global, entries, packages: api, legacy }) };
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
  const ids = entries
    .filter((entry) => old.some(({ name }) => name === entry.package))
    .filter((entry) => !present.has(entry.id))
    .map((entry) => entry.id);
  for (const id of ids) await packages.act(id, 'install').catch(() => undefined);
  await write(
    root,
    MOVED,
    `${JSON.stringify(old.map(({ name, version }) => `${name}@${version}`))}\n`
  );
  return ids;
}
