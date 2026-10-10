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

const INSTALL = ['pnpm', 'install', '--frozen-lockfile', '--trust-lockfile'];

export async function pnpm(kernel, cwd, report, to = null, argv = INSTALL) {
  let log = '';
  report({ progress: null, log });
  const onStdout = (chunk) => {
    log = (log + chunk).slice(-LOG);
    report({ progress: progress(log), log });
  };
  const { status, stderr } = await kernel.run(argv, { cwd, onStdout });
  if (status) {
    const error = new Error(stderr.trim() || `pnpm exited with ${status}`);
    error.log = (log + stderr).slice(-LOG);
    error.to = to;
    throw error;
  }
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

async function install(kernel, from, report) {
  const root = await navigator.storage.getDirectory();
  const lock = await fetchText('pnpm-lock.yaml', from);
  if (lock === (await text(root, 'var/lib/slicc/pnpm-lock.yaml'))) return null;
  const manifest = await fetchText('package.json', from);
  const names = Object.keys(JSON.parse(manifest).dependencies ?? {});
  const before = await versions(root, names);
  await write(root, 'package.json', manifest);
  await write(root, 'pnpm-lock.yaml', lock);
  await pnpm(kernel, '/', report);
  await write(root, 'var/lib/slicc/pnpm-lock.yaml', lock);
  const after = await versions(root, names);
  return names
    .filter((name) => before[name] !== after[name])
    .map((name) => ({ name, from: before[name], to: after[name] }));
}

export function update(kernel, { from = deployed, report = () => {} } = {}) {
  return navigator.locks.request('slicc-packages', () => install(kernel, from, report));
}
