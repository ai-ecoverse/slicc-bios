const TAR = 'https://cdn.jsdelivr.net/npm/modern-tar@0.8.5/dist/web/index.js';
const INTEGRITY = new URL('sw/integrity.js', self.location.href).href;
let ledger;

function integrity() {
  ledger ??= import(INTEGRITY).then(({ openIntegrity }) => openIntegrity());
  return ledger;
}
const root = navigator.storage.getDirectory();
let connections = 0;
let handles = new Map();

function directory(names, create = true) {
  const key = names.join('/');
  if (handles.has(key)) return handles.get(key);
  if (!names.length) return root;
  const dir = directory(names.slice(0, -1), create).then((handle) =>
    handle.getDirectoryHandle(names.at(-1), { create })
  );
  if (create) {
    handles.set(key, dir);
    dir.catch(() => {
      if (handles.get(key) === dir) handles.delete(key);
    });
  }
  return dir;
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

const IDLE = 30000;
const stalled = Symbol('stalled');
let heard = 0;

function within(promise) {
  let timer;
  promise.catch(() => {});
  const since = Date.now();
  const idle = new Promise((resolve) => {
    const wait = () => {
      const quiet = Date.now() - Math.max(heard, since);
      if (quiet >= IDLE) resolve(stalled);
      else timer = setTimeout(wait, IDLE - quiet);
    };
    timer = setTimeout(wait, IDLE);
  });
  return Promise.race([promise, idle]).finally(() => clearTimeout(timer));
}

async function receive(url, signal) {
  const response = await within(fetch(url, { signal }));
  if (response === stalled) return stalled;
  heard = Date.now();
  if (!response.ok) throw new Error(`${response.status} ${response.url}`);
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const next = await within(reader.read());
    if (next === stalled) return stalled;
    heard = Date.now();
    if (next.done) return new Blob(chunks).arrayBuffer();
    chunks.push(next.value);
  }
}

async function download(url) {
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const bytes = await receive(url, controller.signal);
    if (bytes !== stalled) return bytes;
    controller.abort();
    if (attempt === 2) throw new Error(`stalled: ${url}`);
    console.warn(`no data for ${IDLE / 1000} s, fetching again: ${url}`);
  }
}

async function verify(bytes, integrity, path) {
  const [algorithm, expected] = integrity.split('-');
  const digest = await crypto.subtle.digest(algorithm.replace('sha', 'SHA-'), bytes);
  const actual = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (actual !== expected) throw new Error(`integrity mismatch for ${path}`);
}

function entryName(name) {
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) return '';
  return (parts.length > 1 ? parts.slice(1) : parts).join('/');
}

async function unpack(bytes, path) {
  const { createTarDecoder } = await import(TAR);
  const { sha256 } = await import(INTEGRITY);
  const gzip = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const files = new Map();
  for await (const { header, body } of gzip.pipeThrough(createTarDecoder())) {
    const name = entryName(header.name);
    if (header.type === 'file' && name) {
      const data = await new Response(body).arrayBuffer();
      await save(`${path}/${name}`, data);
      const at = `/${path}/${name}`;
      files.set(at, { path: at, size: data.byteLength, sha256: await sha256(data) });
    } else {
      await body.cancel();
    }
  }
  return [...files.values()];
}

function owner(path, packages) {
  return packages
    .filter((name) => path.startsWith(`/${name}/`))
    .sort((a, b) => b.length - a.length)[0];
}

async function current(path, entry, changed) {
  if (changed.has(path)) return false;
  await read(`${path}/package.json`);
  const known = await (await integrity()).source(path);
  return known?.integrity === entry.integrity;
}

async function add([path, entry], changed) {
  const { resolved, integrity: expected } = entry;
  if (await current(path, entry, changed).catch(() => false)) return 0;
  const bytes = await download(resolved);
  await verify(bytes, expected, path);
  await clear(path);
  const files = await unpack(bytes, path);
  await (await integrity()).record(path, files, expected);
  await save(`var/lib/bios/${path}.json`, JSON.stringify({ resolved, integrity: expected }));
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
    await (await integrity()).forget(path);
  }
  return stale.length;
}

async function packages({ from, held = false }, progress) {
  if (held) return replay(from, progress);
  return navigator.locks.request('slicc-packages', () => replay(from, progress));
}

async function replay(from, progress) {
  const lock = JSON.parse(new TextDecoder().decode(await download(from)));
  const queue = Object.entries(lock.packages).filter(
    ([path, entry]) => path && entry.resolved && !entry.os && !entry.cpu
  );
  const removed = await prune(new Set(queue.map(([path]) => path)));
  const ledger = await integrity();
  const tampered = (await ledger.tampered()).filter((path) => path.startsWith('/node_modules/'));
  const names = queue.map(([path]) => path);
  const changed = new Set(tampered.map((path) => owner(path, names)).filter(Boolean));
  const total = queue.length;
  let done = 0;
  let downloaded = 0;
  let bytes = 0;
  const worker = async () => {
    while (queue.length) {
      const entry = queue.shift();
      const size = await add(entry, changed);
      done += 1;
      downloaded += size ? 1 : 0;
      bytes += size;
      progress({ done, total, path: entry[0] });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const deployed = new URL('./', from);
  await install({ from: deployed, files: ['package.json', 'pnpm-lock.yaml'] }, () => {});
  await install({ from: deployed, to: 'var/lib/slicc/', files: ['pnpm-lock.yaml'] }, () => {});
  await ledger.bump('node_modules');
  const repaired = await ledger.heal('/node_modules/');
  return { packages: total, downloaded, removed, bytes, repaired };
}

async function install({ from, to = '', files, source = null }, progress) {
  const { sha256 } = await import(INTEGRITY);
  let bytes = 0;
  const hashed = [];
  for (const file of files) {
    const data = await download(new URL(file, from));
    await save(to + file, data);
    if (source)
      hashed.push({ path: `/${to}${file}`, size: data.byteLength, sha256: await sha256(data) });
    bytes += data.byteLength;
    progress({ file, bytes });
  }
  if (!source) return { files: files.length, bytes };
  const ledger = await integrity();
  await ledger.record(source, hashed);
  await ledger.bump(source);
  const repaired = await ledger.heal(`/${to}`);
  return { files: files.length, bytes, repaired };
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
