const TAR = 'https://cdn.jsdelivr.net/npm/modern-tar@0.8.5/dist/web/index.js';
const root = navigator.storage.getDirectory();
let connections = 0;
let handles = new Map();

function directory(names, create = true) {
  const key = names.join('/');
  if (!handles.has(key)) {
    const parent = names.length ? directory(names.slice(0, -1), create) : root;
    const dir = names.length
      ? parent.then((handle) => handle.getDirectoryHandle(names.at(-1), { create }))
      : root;
    handles.set(key, dir);
    dir.catch(() => {
      if (handles.get(key) === dir) handles.delete(key);
    });
  }
  return handles.get(key);
}

function forget(path) {
  for (const key of handles.keys()) {
    if (key === path || key.startsWith(`${path}/`)) handles.delete(key);
  }
}

async function open(path, create = false) {
  const names = path.split('/');
  const name = names.pop();
  return (await directory(names, create)).getFileHandle(name, { create });
}

async function read(path) {
  return (await open(path)).getFile();
}

async function save(path, data) {
  const writable = await (await open(path, true)).createWritable();
  await writable.write(data);
  await writable.close();
}

async function remove(path) {
  const names = path.split('/');
  const name = names.pop();
  await (await directory(names)).removeEntry(name, { recursive: true }).catch(() => {});
  forget(path);
}

async function clear(path) {
  const dir = await directory(path.split('/'));
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  for (const name of names.filter((entry) => entry !== 'node_modules')) {
    await dir.removeEntry(name, { recursive: true });
    forget(`${path}/${name}`);
  }
}

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.url}`);
  return response;
}

async function verify(bytes, integrity, path) {
  const [algorithm, expected] = integrity.split('-');
  const digest = await crypto.subtle.digest(algorithm.replace('sha', 'SHA-'), bytes);
  const actual = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (actual !== expected) throw new Error(`integrity mismatch for ${path}`);
}

async function unpack(bytes, path) {
  const { createTarDecoder } = await import(TAR);
  const gzip = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  for await (const { header, body } of gzip.pipeThrough(createTarDecoder())) {
    const name = header.name.slice(header.name.indexOf('/') + 1);
    if (header.type === 'file' && name) {
      await save(`${path}/${name}`, await new Response(body).arrayBuffer());
    } else {
      await body.cancel();
    }
  }
}

async function linked() {
  try {
    return JSON.parse(await (await read('node_modules/.modules.yaml')).text()).hoistedLocations;
  } catch {
    return {};
  }
}

async function current(path, { version, integrity }, pnpm) {
  await read(`${path}/package.json`);
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (pnpm[`${name}@${version}`]?.includes(path)) return true;
  const receipt = JSON.parse(await (await read(`var/lib/bios/${path}.json`)).text());
  return receipt.integrity === integrity;
}

async function add([path, entry], pnpm) {
  const { resolved, integrity } = entry;
  if (await current(path, entry, pnpm).catch(() => false)) return 0;
  const bytes = await (await get(resolved)).arrayBuffer();
  await verify(bytes, integrity, path);
  await clear(path);
  await unpack(bytes, path);
  await save(`var/lib/bios/${path}.json`, JSON.stringify({ resolved, integrity }));
  return bytes.byteLength;
}

async function prune(locked) {
  const receipts = await list(await directory(['var', 'lib', 'bios']), '');
  const stale = receipts
    .map((receipt) => receipt.path.replace(/\.json$/, ''))
    .filter((path) => !locked.has(path));
  for (const path of stale) {
    await remove(path);
    await remove(`var/lib/bios/${path}.json`);
  }
  return stale.length;
}

async function packages({ from }, progress) {
  return navigator.locks.request('slicc-packages', () => replay(from, progress));
}

async function replay(from, progress) {
  const lock = await (await get(from)).json();
  const queue = Object.entries(lock.packages).filter(([path, entry]) => path && entry.resolved);
  const removed = await prune(new Set(queue.map(([path]) => path)));
  const pnpm = (await linked()) ?? {};
  const total = queue.length;
  let done = 0;
  let downloaded = 0;
  let bytes = 0;
  const worker = async () => {
    while (queue.length) {
      const entry = queue.shift();
      const size = await add(entry, pnpm);
      done += 1;
      downloaded += size ? 1 : 0;
      bytes += size;
      progress({ done, total, path: entry[0] });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  await install({ from: new URL('./', from), files: ['package.json', 'pnpm-lock.yaml'] }, () => {});
  return { packages: total, downloaded, removed, bytes };
}

async function install({ from, to = '', files }, progress) {
  let bytes = 0;
  for (const file of files) {
    const data = await (await get(new URL(file, from))).arrayBuffer();
    await save(to + file, data);
    bytes += data.byteLength;
    progress({ file, bytes });
  }
  return { files: files.length, bytes };
}

async function list(dir, prefix) {
  const entries = [];
  for await (const handle of dir.values()) {
    const path = prefix + handle.name;
    if (handle.kind === 'directory') entries.push(...(await list(handle, `${path}/`)));
    else entries.push({ path, size: (await handle.getFile()).size });
  }
  return entries;
}

const ops = {
  hello: () => ({ connections }),
  install,
  list: async () => (await list(await root, '')).sort((a, b) => (a.path < b.path ? -1 : 1)),
  packages,
};

self.onconnect = ({ ports: [port] }) => {
  connections += 1;
  port.onmessage = async ({ data: { id, op, args } }) => {
    handles = new Map();
    try {
      const result = await ops[op](args, (progress) => port.postMessage({ id, progress }));
      port.postMessage({ id, result });
    } catch (error) {
      port.postMessage({ id, error: error.message });
    }
  };
};
