import { compare, installedLock, refusal } from './packages.js';
import { BIOS } from './site.js';
import { fetchText, installer, pnpm, readable, remove, text, write } from './update.js';

export const FOLDER = 'opt/slicc/tools';
export const MODULES = `/${FOLDER}/node_modules`;
export const CAP = 2 * 60 * 1000;
export const LIMIT = 180;
export const RETIRE = 30 * 1000;
export const NOTE = 'Seven installs it after boot, at the newest version that passes its checks.';
const deployed = new URL('packages/', BIOS);
export const WORKSPACE =
  "autoInstallPeers: false\nminimumReleaseAgeExclude:\n  - '@ai-ecoverse/*'\n";
const SAFE = ['--ignore-scripts', '--ignore-pnpmfile'];
export const RESOLVE = ['pnpm', 'install', '--lockfile-only', ...SAFE];
export const INSTALL = ['pnpm', 'install', '--frozen-lockfile', ...SAFE];
const MANIFEST = `${FOLDER}/package.json`;
const LOCK = `${FOLDER}/pnpm-lock.yaml`;

export async function loadTools(from = deployed) {
  const listed = JSON.parse(await fetchText('tools.json', from));
  return Object.entries(listed).map(([name, entry]) => ({
    id: entry.id,
    label: entry.label,
    package: name,
    first: entry.first === true,
    requires: [],
  }));
}

const parse = (data) => {
  try {
    return JSON.parse(data ?? 'null');
  } catch {
    return null;
  }
};

async function versionAt(root, path) {
  return parse(await text(root, `${path}/package.json`))?.version ?? null;
}

export async function present(root, entries) {
  const found = new Map();
  for (const entry of entries) {
    const tools = await versionAt(root, `${FOLDER}/node_modules/${entry.package}`);
    const old = await versionAt(root, `node_modules/${entry.package}`);
    found.set(entry.package, { tools, old });
  }
  return found;
}

export function target(offer, { tools, old }) {
  const have = tools ?? old;
  const offered = offer && !offer.withheld ? offer.version : null;
  if (!offered) return tools;
  if (!have) return offered;
  return compare(offered, have) > 0 ? offered : have;
}

function manifest(dependencies) {
  const sorted = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1))
  );
  return `${JSON.stringify({ name: 'slicc-tools', private: true, dependencies: sorted }, null, 2)}\n`;
}

export function row(entry, { version, offer, state, error, log }) {
  const offered = offer && !offer.withheld ? offer.version : null;
  const outdated = Boolean(version && offered && compare(offered, version) > 0);
  const idle = state === 'installed' || state === 'available';
  const settledState = version ? (outdated ? 'outdated' : 'installed') : 'available';
  const now = idle ? settledState : state;
  return {
    id: `tools:${entry.id}`,
    package: entry.package,
    label: entry.label,
    description: offer?.description ?? '',
    commands: offer?.commands ?? [],
    requires: [],
    notes: [NOTE],
    preinstalled: true,
    state: now,
    version,
    offered: offered ?? version,
    ...(offer?.size ? { size: offer.size, unpacked: true } : {}),
    ...(offer?.withheld ? { withheld: offer.withheld } : {}),
    ...(offer?.newer ? { newer: offer.newer } : {}),
    ...(offer === null ? { registry: 'unreachable' } : {}),
    progress: null,
    error: error ?? null,
    ...(log ? { log } : {}),
    actions: now === 'failed' ? ['retry'] : now === 'outdated' ? ['update'] : [],
  };
}

export function graph(lock) {
  const needs = new Map();
  const at = lock.indexOf('\nsnapshots:\n');
  if (at < 0) return needs;
  let current = null;
  for (const line of lock.slice(at + 12).split('\n')) {
    const top = /^ {2}'?([^'\s][^']*?)'?:(?: \{\})?$/.exec(line);
    if (top) {
      current = top[1].replace(/\(.*$/, '');
      needs.set(current, []);
      continue;
    }
    const dep = /^ {6}'?(@?[^'\s:]+)'?: '?([^'\s(]+)/.exec(line);
    if (dep && current) needs.get(current).push(`${dep[1]}@${dep[2]}`);
  }
  return needs;
}

export function reach(needs, key) {
  const seen = new Set([key]);
  const todo = [key];
  while (todo.length)
    for (const next of needs.get(todo.pop()) ?? [])
      if (!seen.has(next)) {
        seen.add(next);
        todo.push(next);
      }
  return seen;
}

async function put(root, path, body) {
  if (body === null) await remove(root, path);
  else await write(root, path, body);
}

async function installTools({ root, kernel, npm }, wanted, batch) {
  const before = [await text(root, MANIFEST), await text(root, LOCK)];
  const back = () => Promise.all([put(root, MANIFEST, before[0]), put(root, LOCK, before[1])]);
  await write(root, MANIFEST, manifest(wanted));
  if ((await text(root, `${FOLDER}/pnpm-workspace.yaml`)) !== WORKSPACE)
    await write(root, `${FOLDER}/pnpm-workspace.yaml`, WORKSPACE);
  let log = '';
  const run = (argv) =>
    pnpm(
      kernel,
      `/${FOLDER}`,
      (step) => {
        log = step.log ?? log;
      },
      null,
      argv,
      true,
      LIMIT
    ).catch((error) => {
      throw Object.assign(error, { log: error.log ?? log });
    });
  try {
    await run(RESOLVE);
    const lockText = (await text(root, LOCK)) ?? '';
    const lock = installedLock(lockText);
    const tops = new Set(Object.entries(wanted).map(([name, version]) => `${name}@${version}`));
    const verdicts = await npm.judged(lock, tops);
    const bad = [...verdicts].filter(([, why]) => why);
    const needs = graph(lockText);
    const refused = new Map();
    const covered = new Set();
    for (const entry of batch) {
      if (!Object.hasOwn(wanted, entry.package)) continue;
      const key = `${entry.package}@${wanted[entry.package]}`;
      const tree = reach(needs, key);
      const hit = [...tree].find((one) => verdicts.get(one));
      if (!lock.has(key)) refused.set(entry.package, { why: `pnpm didn't resolve ${key}` });
      else if (hit) refused.set(entry.package, verdicts.get(hit));
      if (refused.has(entry.package)) for (const one of tree) covered.add(one);
    }
    const stray = bad.find(([one]) => !covered.has(one));
    if (stray) {
      await back();
      throw new Error(`${stray[0]} fails the checks: ${stray[1].why}`);
    }
    if (refused.size) {
      await back();
      return refused;
    }
    await run(INSTALL);
    return refused;
  } catch (error) {
    await back();
    throw error;
  }
}

export function createTools({
  root,
  kernel,
  npm,
  entries,
  emit = () => {},
  retire = (names) => installer('retire', { names }),
  patience = RETIRE,
  locks = navigator.locks,
  cap = CAP,
}) {
  const offers = new Map();
  const states = new Map();
  const verdicts = new Map();
  let found = new Map();
  let running = null;
  let first = null;

  const rows = () =>
    entries.map((entry) => {
      const have = found.get(entry.package) ?? {};
      return row(entry, {
        version: have.tools ?? have.old ?? null,
        offer: offers.has(entry.package) ? offers.get(entry.package) : undefined,
        ...(states.get(entry.package) ?? { state: 'installed' }),
      });
    });
  const changed = () => emit(rows());
  const mark = (list, state) => {
    for (const entry of list) states.set(entry.package, state);
    changed();
  };

  const install = (wanted, batch) => installTools({ root, kernel, npm }, wanted, batch);

  async function plan(batch) {
    found = await present(root, entries);
    const looked = await Promise.all(
      batch.map((entry) => npm.offer(entry, verdicts).catch(() => null))
    );
    for (const [i, entry] of batch.entries()) offers.set(entry.package, looked[i]);
    const current = parse(await text(root, `${FOLDER}/package.json`))?.dependencies ?? {};
    const wanted = { ...current };
    const moving = [];
    for (const entry of batch) {
      const have = found.get(entry.package);
      const to = target(offers.get(entry.package), have);
      if (!to || to === have.tools) continue;
      wanted[entry.package] = to;
      moving.push(entry);
    }
    return { current, wanted, moving };
  }

  async function attempt({ current, wanted, moving }) {
    const refused = await install(wanted, moving);
    if (!refused.size) return refused;
    for (const name of refused.keys()) {
      if (Object.hasOwn(current, name)) wanted[name] = current[name];
      else delete wanted[name];
    }
    const again = await install(
      wanted,
      moving.filter((entry) => !refused.has(entry.package))
    );
    if (again.size) throw new Error(`${[...again.keys()].join(', ')} still fail the checks`);
    return refused;
  }

  function failed(moving, error) {
    for (const entry of moving)
      states.set(entry.package, {
        state: 'failed',
        error: `Couldn't install ${entry.label}: pnpm stopped with an error, shown in the install log. Retry.`,
        log: [error.log, error.message].filter(Boolean).join('\n'),
      });
  }

  async function settleRows(moving, refused) {
    found = await present(root, entries);
    for (const entry of moving) {
      const why = refused.get(entry.package);
      const have = found.get(entry.package);
      const previous = have.tools ?? have.old;
      states.set(
        entry.package,
        why
          ? { state: 'failed', error: refusal(why, entry.label, previous) }
          : { state: 'installed' }
      );
    }
    const done = moving
      .filter((entry) => !refused.has(entry.package) && found.get(entry.package).old)
      .map((entry) => entry.package);
    if (!done.length) return;
    for (const name of done) await remove(root, `node_modules/${name}`);
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("the installer didn't answer retire")), patience);
    });
    await Promise.race([retire(done), late])
      .catch((error) => console.warn(`tools: ${error.message}`))
      .finally(() => clearTimeout(timer));
    found = await present(root, entries);
  }

  async function round(batch) {
    const planned = await plan(batch);
    if (!planned.moving.length) return mark(batch, { state: 'installed' });
    mark(planned.moving, { state: 'installing' });
    try {
      const refused = await attempt(planned);
      await readable(kernel, `/${FOLDER}`);
      await settleRows(planned.moving, refused);
    } catch (error) {
      failed(planned.moving, error);
      found = await present(root, entries);
    }
    changed();
  }

  function settle() {
    running ??= locks
      .request('slicc-tools', async () => {
        await round(entries.filter((entry) => entry.first));
        await round(entries.filter((entry) => !entry.first));
      })
      .finally(() => {
        running = null;
      });
    first ??= running;
    return running;
  }

  function settled(ms = cap) {
    const pending = first ?? settle();
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve('late'), ms);
    });
    return Promise.race([pending.then(() => 'settled'), late]).finally(() => clearTimeout(timer));
  }

  async function act(id, action) {
    const entry = entries.find((one) => `tools:${one.id}` === id);
    if (!entry) throw new Error(`${id} is not one of seven's tools`);
    if (!['retry', 'update'].includes(action)) throw new Error(`${entry.label} can't ${action}`);
    states.delete(entry.package);
    await settle();
    const state = states.get(entry.package);
    if (state?.state === 'failed') throw new Error(state.error);
  }

  async function refresh() {
    found = await present(root, entries);
    changed();
  }

  return { rows, settle, settled, act, refresh };
}
