const TAR = 'https://cdn.jsdelivr.net/npm/modern-tar@0.8.5/dist/web/index.js';
const root = navigator.storage.getDirectory();
let connections = 0;

async function directory(names) {
  let dir = await root;
  for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

async function open(path, create = false) {
  const names = path.split('/');
  const name = names.pop();
  let dir = await root;
  for (const part of names) dir = await dir.getDirectoryHandle(part, { create });
  return dir.getFileHandle(name, { create });
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
}

async function clear(path) {
  const dir = await directory(path.split('/'));
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  for (const name of names.filter((entry) => entry !== 'node_modules')) {
    await dir.removeEntry(name, { recursive: true });
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
      await body.pipeTo(await (await open(`${path}/${name}`, true)).createWritable());
    } else {
      await body.cancel();
    }
  }
}

async function current(path, integrity) {
  const receipt = JSON.parse(await (await read(`var/lib/bios/${path}.json`)).text());
  await read(`${path}/package.json`);
  return receipt.integrity === integrity;
}

async function add([path, { resolved, integrity }]) {
  if (await current(path, integrity).catch(() => false)) return 0;
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
  const lock = await (await get(from)).json();
  const queue = Object.entries(lock.packages).filter(([path, entry]) => path && entry.resolved);
  const removed = await prune(new Set(queue.map(([path]) => path)));
  const total = queue.length;
  let done = 0;
  let downloaded = 0;
  let bytes = 0;
  const worker = async () => {
    while (queue.length) {
      const entry = queue.shift();
      const size = await add(entry);
      done += 1;
      downloaded += size ? 1 : 0;
      bytes += size;
      progress({ done, total, path: entry[0] });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { packages: total, downloaded, removed, bytes };
}

async function install({ from, to = '', files }, progress) {
  let bytes = 0;
  for (const file of files) {
    const response = await get(new URL(file, from));
    const writable = await (await open(to + file, true)).createWritable();
    const counter = new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        progress({ file, bytes });
        controller.enqueue(chunk);
      },
    });
    await response.body.pipeThrough(counter).pipeTo(writable);
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
    try {
      const result = await ops[op](args, (progress) => port.postMessage({ id, progress }));
      port.postMessage({ id, result });
    } catch (error) {
      port.postMessage({ id, error: error.message });
    }
  };
};
