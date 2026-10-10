import { fetchText, pnpm, text, write } from './update.js';

const deployed = new URL('../packages/optional/', import.meta.url);
export const GLOBAL = 'home/.local/share/pnpm/global/v11';
const HOME = /^\/[^\0]*[^/]$/;
export const LISTING = 'etc/slicc/optional.json';
const RUNNING = { install: 'installing', update: 'updating', remove: 'removing' };
const LOCKED =
  /^ {2}'?((?:@[^/\s]+\/)?[^@'\s]+)@([^'(\s]+)'?:\n {4}resolution: \{integrity: ([^,}\s]+)/gm;

export const MISMATCH =
  "This version doesn't match the tested build, so it was removed again. Retry later.";

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
  const entries = Object.entries(catalog).map(([name, entry]) => ({
    ...entry,
    package: name,
    requires: entry.requires ?? [],
    offered: manifest.dependencies[name],
  }));
  return { entries, certified };
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
      if (installed.version) found.push({ name: dependency, version: installed.version, lock });
    }
  }
  return found;
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

export function createPackages({ catalog, root, kernel, ask, emit, global = GLOBAL }) {
  const { entries, certified } = catalog;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const live = new Map();
  let installed = new Map();

  const item = (entry) => {
    const version = installed.get(entry.package) ?? null;
    const running = live.get(entry.id);
    const outdated = version !== null && compare(entry.offered, version) > 0;
    const base = {
      id: entry.id,
      package: entry.package,
      label: entry.label,
      description: entry.description,
      commands: entry.commands,
      requires: entry.requires,
      version,
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
        actions: version === null ? ['retry'] : ['retry', 'remove'],
      };
    }
    if (running) return { ...base, ...running, actions: [] };
    if (version === null) return { ...base, state: 'available', actions: ['install'] };
    if (outdated) return { ...base, state: 'outdated', actions: ['update', 'remove'] };
    return { ...base, state: 'installed', actions: ['remove'] };
  };

  const list = () => entries.map(item);
  const changed = () => emit(list());

  async function refresh() {
    const found = await globals(root, global);
    installed = new Map();
    for (const { name, version } of found) {
      const before = installed.get(name);
      if (!before || compare(version, before) > 0) installed.set(name, version);
    }
    changed();
    return found;
  }

  async function run(entry, action, argv) {
    live.set(entry.id, { state: RUNNING[action], progress: null, log: '' });
    changed();
    await pnpm(
      kernel,
      '/home',
      ({ progress, log }) => {
        live.set(entry.id, {
          state: RUNNING[action],
          progress: progress && progress.total > 1 ? progress : null,
          log: `${entry.package}@${entry.offered}\n${log}`,
        });
        changed();
      },
      entry.offered,
      argv
    );
  }

  async function add(entry, action) {
    await run(entry, action, ['pnpm', 'add', '-g', `${entry.package}@${entry.offered}`]);
    const found = await refresh();
    const mine = found.filter(
      ({ name, version }) => name === entry.package && version === entry.offered
    );
    const key = `${entry.package}@${entry.offered}`;
    if (!mine.length || mine.some(({ lock }) => !tested(lock, certified, key))) {
      await run(entry, 'remove', ['pnpm', 'remove', '-g', entry.package]);
      throw Object.assign(
        new Error(`${entry.package}@${entry.offered} failed the integrity check`),
        {
          plain: MISMATCH,
        }
      );
    }
  }

  async function perform(entry, action) {
    if (action === 'remove') {
      await run(entry, action, ['pnpm', 'remove', '-g', entry.package]);
      return;
    }
    for (const id of entry.requires) {
      const needed = byId.get(id);
      if (!needed || installed.has(needed.package)) continue;
      await attempt(needed, 'install').catch((error) => {
        throw Object.assign(error, {
          plain: `Couldn't install ${needed.label}, which ${entry.label} needs. Retry.`,
        });
      });
    }
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
      (other) => other.requires.includes(entry.id) && installed.has(other.package)
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
    if (action === 'remove' && !(await removable(entry))) return;
    live.set(id, { state: 'queued', progress: null });
    changed();
    let failed = null;
    try {
      await navigator.locks.request('slicc-optional', () => attempt(entry, action));
    } catch (error) {
      failed = error;
    }
    await refresh().catch(changed);
    if (failed) throw new Error(live.get(id).error);
  }

  return { list, refresh, act };
}
