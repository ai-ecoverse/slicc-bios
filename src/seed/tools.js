import { compare, installedLock, refusal } from './packages.js';
import { BIOS } from './site.js';
import { fetchText, installer, pnpm, readable, remove, text, write } from './update.js';

export const FOLDER = 'opt/slicc/tools';
export const MODULES = `/${FOLDER}/node_modules`;
export const CAP = 2 * 60 * 1000;
export const NOTE = 'Seven installs it after boot, at the newest version that passes its checks.';
const deployed = new URL('packages/', BIOS);
const WORKSPACE = "minimumReleaseAgeExclude:\n  - '@ai-ecoverse/*'\n";
const INSTALL = ['pnpm', 'install', '--no-frozen-lockfile'];

export async function loadTools(from = deployed) {
  const listed = JSON.parse(await fetchText('tools.json', from));
  return Object.entries(listed).map(([name, entry]) => ({
    id: entry.id,
    label: entry.label,
    package: name,
    first: entry.first === true,
    ...(typeof entry.pin === 'string' ? { pin: entry.pin } : {}),
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

export function createTools({
  root,
  kernel,
  npm,
  entries,
  emit = () => {},
  retire = (names) => installer('retire', { names }),
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

  async function install(wanted, batch) {
    await write(root, `${FOLDER}/package.json`, manifest(wanted));
    if ((await text(root, `${FOLDER}/pnpm-workspace.yaml`)) === null)
      await write(root, `${FOLDER}/pnpm-workspace.yaml`, WORKSPACE);
    let log = '';
    await pnpm(
      kernel,
      `/${FOLDER}`,
      (step) => {
        log = step.log ?? log;
      },
      null,
      INSTALL
    ).catch((error) => {
      throw Object.assign(error, { log: error.log ?? log });
    });
    const lock = installedLock((await text(root, `${FOLDER}/pnpm-lock.yaml`)) ?? '');
    const verdicts = await npm.judged(lock);
    const refused = new Map();
    for (const entry of batch) {
      const key = `${entry.package}@${wanted[entry.package]}`;
      if (!Object.hasOwn(wanted, entry.package)) continue;
      const own = verdicts.get(key);
      const other = [...verdicts].find(
        ([one, why]) => why && !Object.keys(wanted).some((name) => one.startsWith(`${name}@`))
      );
      if (!lock.has(key)) refused.set(entry.package, { why: `pnpm didn't install ${key}` });
      else if (own || other) refused.set(entry.package, own ?? other[1]);
    }
    return refused;
  }

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
    await retire(done).catch((error) => console.warn(`tools: ${error.message}`));
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
