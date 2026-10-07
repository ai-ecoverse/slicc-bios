const deployed = new URL('../packages/', import.meta.url);

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

async function versions(dir, names) {
  const found = {};
  for (const name of names) {
    found[name] = JSON.parse(
      (await text(dir, `node_modules/${name}/package.json`)) ?? '{}'
    ).version;
  }
  return found;
}

async function install(kernel, from, report) {
  const root = await navigator.storage.getDirectory();
  const lock = await fetchText('pnpm-lock.yaml', from);
  if (lock === (await text(root, 'var/lib/slicc/pnpm-lock.yaml'))) return null;
  report('updating packages');
  const manifest = await fetchText('package.json', from);
  const names = Object.keys(JSON.parse(manifest).dependencies ?? {});
  const before = await versions(root, names);
  await write(root, 'package.json', manifest);
  await write(root, 'pnpm-lock.yaml', lock);
  const argv = ['pnpm', 'install', '--frozen-lockfile', '--trust-lockfile'];
  const { status, stderr } = await kernel.run(argv, { cwd: '/' });
  if (status) throw new Error(stderr.trim() || `pnpm exited with ${status}`);
  await write(root, 'var/lib/slicc/pnpm-lock.yaml', lock);
  const after = await versions(root, names);
  return names
    .filter((name) => before[name] !== after[name])
    .map((name) => `${name} ${before[name] ?? 'new'} → ${after[name]}`);
}

export function update(kernel, { from = deployed, report = () => {} } = {}) {
  return navigator.locks.request('slicc-packages', () => install(kernel, from, report));
}
