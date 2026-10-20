import { BIOS } from './site.js';

const deployed = new URL('packages/', BIOS);
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

const sink = { files: null };

export function useKernelFiles(files) {
  sink.files = files;
}

export async function rooted(dir) {
  if (!sink.files || typeof dir?.isSameEntry !== 'function') return false;
  return dir.isSameEntry(await navigator.storage.getDirectory()).catch(() => false);
}

export function kernelSink() {
  return sink.files;
}

export async function remove(dir, path) {
  if (await rooted(dir)) return sink.files.rm(path);
  const names = path.split('/');
  const name = names.pop();
  try {
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(name, { recursive: true });
  } catch {}
}

export async function makeDir(dir, path) {
  if (await rooted(dir)) return sink.files.mkdir(path);
  for (const part of path.split('/').filter(Boolean))
    dir = await dir.getDirectoryHandle(part, { create: true });
}

export async function write(dir, path, data) {
  if (await rooted(dir)) return sink.files.write(path, data);
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

const UNITS = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9 };
const DOWNLOADING = /Downloading (\S+): ([\d.]+) (B|kB|MB|GB)\/([\d.]+) (B|kB|MB|GB)(, done)?/g;

export function progress(output, downloads = new Map()) {
  for (const [, name, done, unit, total, of, finished] of output.matchAll(DOWNLOADING))
    downloads.set(name, {
      done: Math.round(done * UNITS[unit]),
      total: Math.round(total * UNITS[of]),
      finished: Boolean(finished),
    });
  const last = [
    ...output.matchAll(/resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/g),
  ].at(-1);
  const [resolved, reused, downloaded, added] = last ? last.slice(1).map(Number) : [0, 0, 0, 0];
  if (added > 0) return { phase: 'link', done: added, total: resolved };
  if (downloads.size) {
    const all = [...downloads.values()];
    const bytes = {
      done: all.reduce((sum, item) => sum + item.done, 0),
      total: all.reduce((sum, item) => sum + item.total, 0),
    };
    const total = Math.max(resolved, all.length);
    const done = Math.min(
      Math.max(reused + downloaded, all.filter((item) => item.finished).length),
      total
    );
    return { phase: 'download', done, total, bytes };
  }
  if (!last) return null;
  return { phase: 'download', done: reused + downloaded, total: resolved };
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
const STORE_DIR = '/opt/slicc/.store';
const HYGIENE = [
  '--ignore-scripts',
  '--ignore-pnpmfile',
  '--config.userconfig=/dev/null',
  `--config.store-dir=${STORE_DIR}`,
  '--config.verify-store-integrity=true',
];
const TRAPS = { SLICC_WASM_BACKTRACE: '1' };
const CLEAN = {
  HOME: INSTALLER,
  XDG_CONFIG_HOME: `${INSTALLER}/.config`,
  XDG_CACHE_HOME: `${INSTALLER}/.cache`,
  PNPM_HOME: SYSTEM,
  PATH: `${SYSTEM}/bin:/usr/local/bin:/usr/bin:/bin`,
  NODE_OPTIONS: '',
  ...TRAPS,
};
const guard = { on: false, enforce: false, writing: new Map(), expected: new Map() };

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

export function installing(kernel, path = null) {
  if (path === null) guard.expected.get(kernel)?.clear();
  else if (guard.expected.get(kernel)?.delete(path)) return true;
  const held = guard.writing.get(kernel);
  if (!held) return false;
  if (path === null) return true;
  return [...held.keys()].some((root) => path === root || path.startsWith(`${root}/`));
}

async function writing_(kernel, roots, task) {
  const held = guard.writing.get(kernel) ?? new Map();
  guard.writing.set(kernel, held);
  for (const root of roots) held.set(root, (held.get(root) ?? 0) + 1);
  try {
    return await task();
  } finally {
    for (const root of roots) {
      const left = held.get(root) - 1;
      if (left) held.set(root, left);
      else held.delete(root);
    }
    if (!held.size) guard.writing.delete(kernel);
  }
}

function writes(cwd, argv) {
  const modules = argv
    .filter((arg) => arg.startsWith('--modules-dir='))
    .map((arg) => arg.slice('--modules-dir='.length));
  return [cwd, ...modules, STORE_DIR, INSTALLER];
}

export function writing(cwd) {
  return guard.on ? { cwd, tag: WRITER, env: CLEAN } : { cwd, env: TRAPS };
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

export const RECEIPT = 'var/lib/slicc/rooted.json';

export async function digest(data) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function receipt(root) {
  try {
    return JSON.parse((await text(root, RECEIPT)) ?? '{}');
  } catch {
    return {};
  }
}

export async function retire(root, deployed = {}) {
  const kept = await receipt(root);
  const retired = [];
  for (const name of ROOTED) {
    const data = await text(root, name);
    if (data === null) continue;
    if (data !== deployed[name] && (await digest(data)) !== kept[name]) continue;
    await remove(root, name);
    retired.push(`/${name}`);
  }
  if ((await text(root, RECEIPT)) !== null) await remove(root, RECEIPT);
  return retired;
}

const shielded = (path) => PROTECTED.some((root) => path === root || path.startsWith(`${root}/`));

export async function kernelFiles(kernel, attach) {
  const client = await attach(await kernel.connect(guard.on ? { tag: WRITER } : {}));
  let held = guard.expected.get(kernel);
  if (!held) guard.expected.set(kernel, (held = new Set()));
  const expect = async (paths, task) => {
    const mine = paths.filter((path) => shielded(path) && !held.has(path));
    for (const path of mine) held.add(path);
    try {
      return await task();
    } catch (error) {
      for (const path of mine) held.delete(path);
      throw error;
    }
  };
  const parents = async (at) => {
    const parts = at.split('/').filter(Boolean);
    parts.pop();
    let path = '';
    for (const part of parts) {
      path += `/${part}`;
      if (await client.fs.exists(path)) continue;
      const made = path;
      await expect([made], () => client.fs.mkdir(made));
    }
  };
  const put = async (at, data) => {
    await parents(at);
    await expect([at], () => client.fs.writeFile(at, data));
  };
  return {
    write: (path, data) => put(`/${path}`, data),
    async rm(path) {
      const at = `/${path}`;
      if (!(await client.fs.exists(at))) return;
      await expect([at], () => client.fs.rm(at, { force: true }));
    },
    mkdir: (path) => parents(`/${path}/x`),
    async append(path, text, cap) {
      const at = `/${path}`;
      const size = (await client.fs.exists(at)) ? (await client.fs.stat(at)).size : 0;
      const added = new TextEncoder().encode(text).length;
      if (!size) return put(at, text);
      if (size + added > cap) {
        const old = `${at}.1`;
        if (await client.fs.exists(old))
          await expect([old], () => client.fs.rm(old, { force: true }));
        await expect([at, old], () => client.fs.rename(at, old));
        return put(at, text);
      }
      await expect([at], async () => {
        const { status, stderr } = await client.run(['sh', '-c', 'cat >> "$1"', 'sh', at], {
          cwd: '/',
          stdin: text,
        });
        if (status) throw new Error(stderr.trim() || `appending to ${at} exited with ${status}`);
      });
    },
  };
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
  connect = () => new SharedWorker(new URL('installer.js', BIOS), 'slicc-installer')
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

export const STORE = 'slicc-pnpm-store';

export function pnpm(kernel, cwd, report, to = null, argv = INSTALL, writer = true) {
  return navigator.locks.request(STORE, () => pnpmAlone(kernel, cwd, report, to, argv, writer));
}

const TRAP = /^[^\n]*: wasm trap in thread \d+: memory access out of bounds$/m;
const TRAP_ISSUES = 'homescoop#1127, slicc-kernel#1172';
export const TRAP_LOG = 'var/log/slicc/pnpm-traps.log';
const TRAP_CAP = 64 * 1024;

async function noteTrap(cwd, argv, line, outcome) {
  const files = kernelSink();
  if (!files) return;
  const entry = { at: new Date().toISOString(), cwd, argv: argv.join(' '), line, outcome };
  await files
    .append(TRAP_LOG, `${JSON.stringify(entry)}\n`, TRAP_CAP)
    .catch((error) => console.warn(`${TRAP_LOG}: ${error.message}`));
}

export function trapLine(status, stderr) {
  return status === 134 ? (stderr.match(TRAP)?.[0] ?? null) : null;
}

export function pnpmAs(kernel, { user, home, where }, report, to, argv) {
  const env = { HOME: home, PNPM_HOME: where, PATH: `${where}/bin:/usr/local/bin:/usr/bin:/bin` };
  return pnpmAlone(kernel, home, report, to, argv, false, { user, env: { ...env, ...TRAPS } });
}

async function pnpmAlone(kernel, cwd, report, to, argv, writer, as = null) {
  let log = '';
  const downloads = new Map();
  report({ progress: null, log });
  const onStdout = (chunk) => {
    log = (log + chunk).slice(-LOG);
    report({ progress: progress(log, downloads), log });
  };
  if (writer && guard.on) await fence(await navigator.storage.getDirectory(), cwd);
  const run = as
    ? { cwd, ...as, onStdout }
    : writer
      ? { ...writing(cwd), onStdout }
      : { cwd, env: TRAPS, onStdout };
  const ran = () => kernel.run(writer ? hygiene(argv) : argv, run);
  const attempt = () => (writer ? writing_(kernel, writes(cwd, argv), ran) : ran());
  let { status, stderr } = await attempt();
  const first = trapLine(status, stderr);
  if (first) {
    const note = `bios: pnpm trapped (${first}), the wasm trap of ${TRAP_ISSUES}; retrying once`;
    console.warn(note);
    log = `${log}${stderr}\n${note}\n`.slice(-LOG);
    report({ progress: null, log });
    ({ status, stderr } = await attempt());
    const again = trapLine(status, stderr);
    await noteTrap(
      cwd,
      argv,
      first,
      again ? 'trapped again' : status ? 'failed otherwise' : 'recovered'
    );
    if (again) {
      const error = new Error(
        `pnpm trapped twice with the wasm trap of ${TRAP_ISSUES} (${again}); bios retries it only once`
      );
      error.log = `${log}${stderr}`.slice(-LOG);
      error.to = to;
      console.warn(error.message);
      throw error;
    }
    if (!status) {
      const done = `bios: pnpm's retry after the wasm trap succeeded (${TRAP_ISSUES})`;
      console.warn(done);
      log = `${log}${done}\n`.slice(-LOG);
      report({ progress: null, log });
    }
  }
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
  const { status, stderr } = await writing_(kernel, [path], () =>
    kernel.run(['find', path, ...UNREADABLE, '-exec', 'chmod', 'a+rX', '{}', '+'], writing('/'))
  );
  if (status) {
    throw new Error(
      `making ${path} readable failed: ${stderr.trim() || `find exited with ${status}`}`
    );
  }
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
    const workspace = await fetchText('pnpm-workspace.yaml', from);
    await write(root, `${folder}pnpm-workspace.yaml`, workspace);
    await retire(root, {
      'package.json': manifest,
      'pnpm-lock.yaml': lock,
      'pnpm-workspace.yaml': workspace,
    });
  } else {
    const written = {
      'package.json': await digest(manifest),
      'pnpm-lock.yaml': await digest(lock),
    };
    await write(root, RECEIPT, JSON.stringify(written));
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
