import { compare, locked } from './packages.js';
import { fetchText, pnpm, readable, text, write } from './update.js';

export const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const GATED = /^@ai-ecoverse\/(?:slicc-kernel|slicc-cdp|slicc-jsh|wasi-|wasix-|wasm-|py-)/;
const RELAXED = ['pnpm', 'install', '--no-frozen-lockfile'];
const CERTS = new URL('../packages/certs.json', import.meta.url);
const seen = new Map();

const exact = (spec) => typeof spec === 'string' && EXACT.test(spec);

function parse(data) {
  if (data === null) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function readLayer(data) {
  const found = parse(data) ?? {};
  return { ...found, add: found.add ?? {}, pin: found.pin ?? {} };
}

export function entries(manifest) {
  const found = new Map();
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
      found.set(name, { spec, field });
    }
  }
  return found;
}

export function empty(layer) {
  return !Object.keys(layer.add).length && !Object.keys(layer.pin).length;
}

export function observe(base, current, previous = readLayer(null)) {
  const wanted = entries(base);
  const layer = { add: {}, pin: {} };
  for (const [name, { spec, field }] of entries(current)) {
    const own = wanted.get(name);
    if (!own) {
      layer.add[name] = { spec, field };
    } else if (own.spec !== spec) {
      const kept = previous.pin[name];
      layer.pin[name] = {
        spec,
        field: own.field,
        base: kept?.spec === spec ? kept.base : own.spec,
      };
    }
  }
  if (!previous.error) return layer;
  return {
    add: { ...previous.add, ...layer.add },
    pin: { ...previous.pin, ...layer.pin },
    error: previous.error,
  };
}

function caught({ spec, base }, now) {
  return (
    exact(spec) && exact(base) && exact(now) && compare(spec, base) > 0 && compare(now, spec) >= 0
  );
}

export function settle(layer, base, provided = {}) {
  const wanted = entries(base);
  const next = { add: {}, pin: {} };
  if (layer.error) next.error = layer.error;
  const refused = [];
  const dropped = [];
  for (const kind of ['pin', 'add']) {
    for (const [name, entry] of Object.entries(layer[kind])) {
      if (Object.hasOwn(provided, name)) {
        refused.push({ name, kind, spec: entry.spec, keeps: provided[name] });
        continue;
      }
      const own = wanted.get(name);
      if (!own) {
        next.add[name] = { spec: entry.spec, field: entry.field };
      } else if (kind === 'add' || entry.spec === own.spec || caught(entry, own.spec)) {
        dropped.push({ name, kind, spec: entry.spec });
      } else {
        next.pin[name] = { ...entry, field: own.field };
      }
    }
  }
  return { layer: next, refused, dropped };
}

export function merge(base, layer) {
  const out = structuredClone(base);
  for (const [name, { spec, field }] of [
    ...Object.entries(layer.pin),
    ...Object.entries(layer.add),
  ]) {
    for (const other of FIELDS) delete out[other]?.[name];
    out[field] = { ...out[field], [name]: spec };
  }
  return out;
}

export function same(a, b) {
  const x = entries(a);
  const y = entries(b);
  if (x.size !== y.size) return false;
  for (const [name, { spec, field }] of x) {
    const other = y.get(name);
    if (other?.spec !== spec || other.field !== field) return false;
  }
  return true;
}

export function importers(lock) {
  const block = lock.split(/^importers:\n/m)[1]?.split(/^\S/m)[0] ?? '';
  const own = block.split(/^ {2}\.:\n/m)[1]?.split(/^ {2}\S/m)[0] ?? '';
  const manifest = {};
  let field = null;
  let name = null;
  for (const line of own.split('\n')) {
    const heading = line.match(/^ {4}(\w+):$/);
    const entry = line.match(/^ {6}'?([^']+?)'?:$/);
    const spec = line.match(/^ {8}specifier: '?(.*?)'?$/);
    if (heading) field = FIELDS.includes(heading[1]) ? heading[1] : null;
    else if (entry) name = entry[1];
    else if (field && name && spec) manifest[field] = { ...manifest[field], [name]: spec[1] };
  }
  return manifest;
}

export async function untested(lock, base, certs = () => fetchText('', CERTS).then(JSON.parse)) {
  const shipped = locked(base);
  const found = [...locked(lock)].filter(
    ([key, integrity]) =>
      GATED.test(key.slice(0, key.lastIndexOf('@'))) && shipped.get(key) !== integrity
  );
  if (!found.length) return [];
  const certified = await certs();
  return found
    .filter(([key, integrity]) => certified[key]?.integrity !== integrity)
    .map(([key]) => key);
}

function firstLine(message) {
  return message.split('\n')[0].trim();
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function relaxed(kernel, root, project, report, to, lock, certs) {
  const cwd = `/${project.folder}`;
  try {
    await pnpm(kernel, cwd, report, to, RELAXED);
  } catch (error) {
    return `Couldn't install your packages in ${cwd} (${firstLine(error.message)}). Seven went back to its own versions; Retry, or remove the package.`;
  }
  const found = await untested(
    (await text(root, `${project.folder}/pnpm-lock.yaml`)) ?? '',
    lock,
    certs
  );
  if (!found.length) return null;
  return `Needs ${found.join(', ')}, which seven hasn't tested. Seven went back to its own versions.`;
}

async function inspect(root, project, force) {
  const { folder, state, from } = project;
  const lock = await fetchText('pnpm-lock.yaml', from);
  const receipt = await text(root, `${state}/pnpm-lock.yaml`);
  const currentText = await text(root, `${folder}/package.json`);
  const saved = readLayer(await text(root, `${state}/user.json`));
  const changed = lock !== receipt;
  const asked = changed || force || Boolean(saved.pending);
  if (!asked && seen.get(folder) === currentText) return null;
  const current = parse(currentText);
  const recordedBase = await text(root, `${state}/package.json`);
  const baseText =
    changed || recordedBase === null ? await fetchText('package.json', from) : recordedBase;
  const base = JSON.parse(baseText);
  let before = parse(recordedBase);
  if (!before && receipt !== null) before = changed ? importers(receipt) : base;
  const observed = before && current ? observe(before, current, saved) : saved;
  const provided = parse(await text(root, 'package.json'))?.dependencies ?? {};
  const { layer, refused } = settle(observed, base, provided);
  const due = asked || (!layer.error && !same(merge(base, layer), current));
  return { lock, changed, currentText, recordedBase, baseText, base, layer, refused, due };
}

async function install(root, project, found, { start, report, certs }) {
  const { folder, from } = project;
  const { lock, changed, baseText, base, layer } = found;
  const plain = empty(layer);
  const wanted = plain ? baseText : json(merge(base, layer));
  await write(root, `${folder}/package.json`, wanted);
  if (changed || plain) await write(root, `${folder}/pnpm-lock.yaml`, lock);
  if (project.workspace && changed) {
    const workspace = await fetchText('pnpm-workspace.yaml', from).catch(() => '{}\n');
    await write(root, `${folder}/pnpm-workspace.yaml`, workspace);
  }
  const to = base.dependencies?.[project.primary];
  const kernel = await start();
  try {
    const error = plain ? null : await relaxed(kernel, root, project, report, to, lock, certs);
    if (!plain && !error) {
      await readable(kernel, `/${folder}`);
      return { wanted, error };
    }
    if (error) {
      await write(root, `${folder}/package.json`, baseText);
      await write(root, `${folder}/pnpm-lock.yaml`, lock);
    }
    await pnpm(kernel, `/${folder}`, report, to);
    await readable(kernel, `/${folder}`);
    return { wanted: error ? baseText : wanted, error };
  } finally {
    kernel.terminate();
  }
}

export async function normalize(root, project, start) {
  const { folder, state } = project;
  if ((await text(root, `${state}/pnpm-lock.yaml`)) === null) return false;
  if ((await text(root, `${state}/readable`)) !== null) return false;
  const kernel = await start();
  try {
    await readable(kernel, `/${folder}`);
  } finally {
    kernel.terminate();
  }
  await write(root, `${state}/readable`, '1\n');
  return true;
}

export async function apply(root, project, options = {}) {
  const { force = false, report = () => {} } = options;
  const { folder, state } = project;
  await normalize(root, project, options.start);
  const found = await inspect(root, project, force);
  if (!found) return false;
  const { layer, refused, baseText } = found;
  if (!found.due) {
    await write(root, `${state}/user.json`, json(layer));
    if (found.recordedBase === null) await write(root, `${state}/package.json`, baseText);
    seen.set(folder, found.currentText);
    return false;
  }
  const { wanted, error } = await install(root, project, found, { ...options, report });
  const kept = error ? { ...layer, error } : { add: layer.add, pin: layer.pin };
  await write(root, `${state}/user.json`, json(kept));
  await write(root, `${state}/package.json`, baseText);
  await write(root, `${state}/applied.json`, wanted);
  await write(root, `${state}/pnpm-lock.yaml`, found.lock);
  await write(root, `${state}/readable`, '1\n');
  seen.set(folder, await text(root, `${folder}/package.json`));
  if (refused.length) options.refuse?.(refused, project);
  return true;
}

export async function edit(root, project, name = null) {
  const { folder, state } = project;
  const layer = readLayer(await text(root, `${state}/user.json`));
  const base = parse(await text(root, `${state}/package.json`)) ?? {};
  if (name !== null) {
    delete layer.add[name];
    delete layer.pin[name];
  }
  await write(root, `${state}/user.json`, json({ ...layer, pending: true }));
  await write(root, `${folder}/package.json`, json(merge(base, layer)));
}

export function change(project, name = null) {
  return navigator.locks.request(project.lock, async () =>
    edit(await navigator.storage.getDirectory(), project, name)
  );
}

export async function userRows(root, project) {
  const { id, folder, state } = project;
  const layer = readLayer(await text(root, `${state}/user.json`));
  const base = entries(parse(await text(root, `${state}/package.json`)));
  const rows = [];
  for (const kind of ['pin', 'add']) {
    for (const [name, { spec }] of Object.entries(layer[kind])) {
      const installed = parse(await text(root, `${folder}/node_modules/${name}/package.json`));
      const undo = kind === 'pin' ? 'unpin' : 'remove';
      rows.push({
        id: `user:${id}:${name}`,
        package: name,
        label: name,
        description: installed?.description ?? `${kind === 'pin' ? 'Pinned' : 'Added'} with pnpm`,
        commands: [],
        origin: 'user',
        pin: {
          base: kind === 'pin' ? (base.get(name)?.spec ?? null) : null,
          range: spec,
          project: `/${folder}`,
        },
        state: layer.error ? 'failed' : 'installed',
        version: layer.error ? spec : (installed?.version ?? spec),
        offered: null,
        progress: null,
        error: layer.error ?? null,
        actions: layer.error ? ['retry', undo] : [undo],
      });
    }
  }
  return rows;
}

export function forget() {
  seen.clear();
}
