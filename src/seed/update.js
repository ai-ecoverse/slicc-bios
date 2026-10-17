const deployed = new URL('../packages/', import.meta.url);
const LOG = 8192;

export async function text(dir, path) {
  const names = path.split('/');
  const name = names.pop();
  try {
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
}

export async function write(dir, path, data) {
  const names = path.split('/');
  const name = names.pop();
  for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

export async function fetchText(name, from) {
  const response = await fetch(new URL(name, from), { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.url}`);
  return response.text();
}

export function progress(output) {
  const last = [
    ...output.matchAll(/resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/g),
  ].at(-1);
  if (!last) return null;
  const [resolved, reused, downloaded, added] = last.slice(1).map(Number);
  return added > 0
    ? { phase: 'link', done: added, total: resolved }
    : { phase: 'download', done: reused + downloaded, total: resolved };
}

export const WRITER = 'bios-installer';
export const PROTECTED = [
  '/node_modules',
  '/opt/agent',
  '/opt/grammars',
  '/opt/tailscale',
  '/opt/slicc',
  '/os',
];
const INSTALLER = '/opt/slicc/.installer';
export const BASE = 'opt/slicc/base';
const SYSTEM = '/usr/local/share/pnpm';
const HYGIENE = [
  '--ignore-scripts',
  '--ignore-pnpmfile',
  '--config.userconfig=/dev/null',
  '--config.store-dir=/opt/slicc/.store',
  '--config.verify-store-integrity=true',
];
const CLEAN = {
  HOME: INSTALLER,
  XDG_CONFIG_HOME: `${INSTALLER}/.config`,
  XDG_CACHE_HOME: `${INSTALLER}/.cache`,
  PNPM_HOME: SYSTEM,
  PATH: `${SYSTEM}/bin:/usr/local/bin:/usr/bin:/bin`,
  NODE_OPTIONS: '',
};
const guard = { on: false, enforce: false, writing: new Map() };

export function protectInstalls(on, enforce = on) {
  guard.on = on;
  guard.enforce = on && enforce;
}

export function protection() {
  return guard.enforce ? { protect: { paths: PROTECTED, writers: [WRITER] } } : {};
}

export function enforced() {
  return guard.enforce;
}

export function installing(kernel) {
  return (guard.writing.get(kernel) ?? 0) > 0;
}

async function writing_(kernel, task) {
  guard.writing.set(kernel, (guard.writing.get(kernel) ?? 0) + 1);
  try {
    return await task();
  } finally {
    const left = guard.writing.get(kernel) - 1;
    if (left) guard.writing.set(kernel, left);
    else guard.writing.delete(kernel);
  }
}

export function writing(cwd) {
  return guard.on ? { cwd, tag: WRITER, env: CLEAN } : { cwd };
}

export function hygiene(argv) {
  return guard.on && argv[0] === 'pnpm' ? [...argv, ...HYGIENE] : argv;
}

export function guarded() {
  return guard.on;
}

const ROOTED = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
];
const FENCE = "minimumReleaseAgeExclude:\n  - '@ai-ecoverse/*'\n";

export async function fence(root, cwd) {
  const folder = cwd.replace(/^\/+|\/+$/g, '');
  if (!folder) return;
  if ((await text(root, `${folder}/pnpm-workspace.yaml`)) === null) {
    await write(root, `${folder}/pnpm-workspace.yaml`, FENCE);
  }
}

export async function retire(root) {
  for (const name of ROOTED) await root.removeEntry(name).catch(() => {});
}

export function project() {
  return guard.on
    ? { folder: `${BASE}/`, cwd: `/${BASE}`, flags: ['--modules-dir=/node_modules'] }
    : { folder: '', cwd: '/', flags: [] };
}

const INSTALL = ['pnpm', 'install', '--frozen-lockfile', '--trust-lockfile'];

export function installer(
  op,
  args,
  connect = () => new SharedWorker(new URL('../installer.js', import.meta.url), 'slicc-installer')
) {
  const { port } = connect();
  return new Promise((resolve, reject) => {
    port.onmessage = ({ data }) => {
      if ('progress' in data) return;
      port.close();
      if ('error' in data) reject(new Error(data.error));
      else resolve(data.result);
    };
    port.postMessage({ id: 1, op, args });
  });
}

export async function pnpm(kernel, cwd, report, to = null, argv = INSTALL, writer = true) {
  let log = '';
  report({ progress: null, log });
  const onStdout = (chunk) => {
    log = (log + chunk).slice(-LOG);
    report({ progress: progress(log), log });
  };
  if (writer && guard.on) await fence(await navigator.storage.getDirectory(), cwd);
  const run = writer ? { ...writing(cwd), onStdout } : { cwd, onStdout };
  const ran = () => kernel.run(writer ? hygiene(argv) : argv, run);
  const { status, stderr } = await (writer ? writing_(kernel, ran) : ran());
  if (status) {
    const error = new Error(stderr.trim() || `pnpm exited with ${status}`);
    error.log = (log + stderr).slice(-LOG);
    error.to = to;
    throw error;
  }
}

const UNREADABLE = [
  '(',
  '!',
  '-perm',
  '-a+r',
  '-o',
  '-perm',
  '/111',
  '!',
  '-perm',
  '-a+x',
  '-o',
  '-type',
  'd',
  '!',
  '-perm',
  '-a+x',
  ')',
];

export async function readable(kernel, path) {
  const { status, stderr } = await writing_(kernel, () =>
    kernel.run(['find', path, ...UNREADABLE, '-exec', 'chmod', 'a+rX', '{}', '+'], writing('/'))
  );
  if (status) throw new Error(stderr.trim() || `chmod exited with ${status}`);
}

export async function baseManifest(root) {
  return JSON.parse(
    (await text(root, `${project().folder}package.json`)) ??
      (await text(root, 'package.json')) ??
      '{}'
  );
}

export async function versions(dir, names, prefix = '') {
  const found = {};
  for (const name of names) {
    found[name] =
      JSON.parse((await text(dir, `${prefix}node_modules/${name}/package.json`)) ?? '{}').version ??
      null;
  }
  return found;
}

async function install(kernel, from, report, record) {
  const root = await navigator.storage.getDirectory();
  const lock = await fetchText('pnpm-lock.yaml', from);
  if (lock === (await text(root, 'var/lib/slicc/pnpm-lock.yaml'))) return null;
  const manifest = await fetchText('package.json', from);
  const names = Object.keys(JSON.parse(manifest).dependencies ?? {});
  const before = await versions(root, names);
  const { folder, cwd, flags } = project();
  await write(root, `${folder}package.json`, manifest);
  await write(root, `${folder}pnpm-lock.yaml`, lock);
  if (guard.on) {
    await write(root, `${folder}pnpm-workspace.yaml`, await fetchText('pnpm-workspace.yaml', from));
    await retire(root);
  }
  await pnpm(kernel, cwd, report, null, [...INSTALL, ...flags]);
  const base = guard.on ? { base: BASE } : {};
  await record('packages', { from: new URL('package-lock.json', from).href, held: true, ...base });
  await write(root, 'var/lib/slicc/pnpm-lock.yaml', lock);
  const after = await versions(root, names);
  return names
    .filter((name) => before[name] !== after[name])
    .map((name) => ({ name, from: before[name], to: after[name] }));
}

export function update(kernel, { from = deployed, report = () => {}, record = installer } = {}) {
  return navigator.locks.request('slicc-packages', () => install(kernel, from, report, record));
}
