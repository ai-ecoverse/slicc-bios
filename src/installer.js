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

async function settle(base, name) {
  const parts = name.split('/');
  const last = parts.pop();
  let dir = await directory(base.split('/'));
  let at = base;
  for (const part of parts) {
    at = `${at}/${part}`;
    const parent = dir;
    dir = await parent.getDirectoryHandle(part, { create: true }).catch(async () => {
      await parent.removeEntry(part);
      forget(at);
      return parent.getDirectoryHandle(part, { create: true });
    });
  }
  await dir.getFileHandle(last, { create: true }).catch(async () => {
    await dir.removeEntry(last, { recursive: true });
    forget(`${at}/${last}`);
  });
}

async function place(base, name, data) {
  await save(`${base}/${name}`, data).catch(async () => {
    await settle(base, name);
    await save(`${base}/${name}`, data);
  });
}

async function sweep(path, keep) {
  const walk = async (dir, at) => {
    const handles = [];
    for await (const handle of dir.values()) handles.push(handle);
    let kept = false;
    for (const handle of handles) {
      const { name } = handle;
      const full = `${at}/${name}`;
      if (at === path && name === 'node_modules') kept = true;
      else if (handle.kind === 'directory' ? await walk(handle, full) : keep.has(`/${full}`))
        kept = true;
      else {
        await dir.removeEntry(name, { recursive: true });
        forget(full);
      }
    }
    return kept;
  };
  await walk(await directory(path.split('/')), path);
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

const KERNEL = 'node_modules/@ai-ecoverse/slicc-kernel';

async function metadata() {
  try {
    const manifest = JSON.parse(await (await read(`${KERNEL}/package.json`)).text());
    const entry = manifest.exports?.['./meta'];
    const target = typeof entry === 'string' ? entry : entry?.default;
    if (!target) return null;
    const code = await (await read(`${KERNEL}/${target.replace(/^\.\//, '')}`)).text();
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    return (await import(url)).writeMetadata ?? null;
  } catch {
    return null;
  }
}

async function stamp(entries) {
  if (!entries.length) return false;
  const write = await metadata();
  if (!write) return false;
  try {
    await write(await root, entries);
    return true;
  } catch (error) {
    console.warn(`modes not recorded: ${error.message}`);
    return false;
  }
}

function entryPoints(manifest) {
  const ranks = new Map([['package.json', 3]]);
  let pkg = {};
  try {
    pkg = JSON.parse(new TextDecoder().decode(manifest ?? new ArrayBuffer(0)));
  } catch {
    return ranks;
  }
  const rank = (file, value) => {
    if (typeof file !== 'string') return;
    const name = entryName(`package/${file}`);
    ranks.set(name, Math.max(ranks.get(name) ?? 0, value));
  };
  const targets = (value) =>
    typeof value === 'string'
      ? [value]
      : Object.values(value && typeof value === 'object' ? value : {}).flatMap(targets);
  const bin = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
  for (const file of [...bin, pkg.main, ...targets(pkg.exports)]) rank(file, 2);
  const commands = pkg.slicc?.commands;
  for (const command of Object.values(commands && typeof commands === 'object' ? commands : {})) {
    if (!command || typeof command !== 'object') continue;
    const variants = Array.isArray(command.variants) ? command.variants : [];
    for (const file of [command.wasm, ...variants.map((variant) => variant?.wasm)]) rank(file, 1);
    rank(command.glue, 2);
    rank(command.script, 2);
  }
  return ranks;
}

async function unpack(bytes, path, stamps = []) {
  const { createTarDecoder } = await import(TAR);
  const { sha256 } = await import(INTEGRITY);
  const gzip = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const read = [];
  for await (const { header, body } of gzip.pipeThrough(createTarDecoder())) {
    const name = entryName(header.name);
    if (header.type === 'file' && name) {
      read.push({ name, mode: header.mode, data: await new Response(body).arrayBuffer() });
    } else {
      await body.cancel();
    }
  }
  const ranks = entryPoints(read.find(({ name }) => name === 'package.json')?.data);
  read.sort((a, b) => (ranks.get(a.name) ?? 0) - (ranks.get(b.name) ?? 0));
  const files = new Map();
  for (const { name, mode, data } of read) {
    await place(path, name, data);
    const at = `/${path}/${name}`;
    files.set(at, { path: at, size: data.byteLength, sha256: await sha256(data) });
    stamps.push({ path: at, mode: (mode ?? 0o644) & 0o7777, uid: 0, gid: 0 });
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
  const ledger = await integrity();
  if ((await ledger.source(path))?.integrity !== entry.integrity) return false;
  for (const { path: at, size } of await ledger.files(path)) {
    if ((await read(at.slice(1))).size !== size) return false;
  }
  return true;
}

async function headers(bytes, path) {
  const { createTarDecoder } = await import(TAR);
  const gzip = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const found = [];
  for await (const { header, body } of gzip.pipeThrough(createTarDecoder())) {
    await body.cancel();
    const name = entryName(header.name);
    if (header.type !== 'file' || !name) continue;
    found.push({ path: `/${path}/${name}`, mode: (header.mode ?? 0o644) & 0o7777, uid: 0, gid: 0 });
  }
  return found;
}

async function receiptOf(path) {
  return JSON.parse(await (await read(`var/lib/bios/${path}.json`)).text());
}

async function marked(paths) {
  for (const path of paths) {
    const receipt = await receiptOf(path).catch(() => null);
    if (receipt)
      await save(`var/lib/bios/${path}.json`, JSON.stringify({ ...receipt, modes: true }));
  }
}

async function repair(entries, fresh) {
  if (!(await metadata())) return [];
  const stamps = [];
  const repaired = [];
  for (const [path, { resolved, integrity: expected }] of entries) {
    if (fresh.has(path)) continue;
    const receipt = await receiptOf(path).catch(() => null);
    if (!receipt || receipt.modes) continue;
    try {
      const bytes = await download(resolved);
      await verify(bytes, expected, path);
      stamps.push(...(await headers(bytes, path)));
      repaired.push(path);
    } catch (error) {
      console.warn(`modes of ${path} not repaired yet: ${error.message}`);
    }
  }
  if (repaired.length && (await stamp(stamps))) await marked(repaired);
  return repaired;
}

async function add([path, entry], changed, stamps, fresh = new Set()) {
  const { resolved, integrity: expected } = entry;
  if (await current(path, entry, changed).catch(() => false)) return 0;
  const bytes = await download(resolved);
  await verify(bytes, expected, path);
  const files = await unpack(bytes, path, stamps);
  await sweep(path, new Set(files.map((file) => file.path)));
  await (await integrity()).record(path, files, expected);
  await save(`var/lib/bios/${path}.json`, JSON.stringify({ resolved, integrity: expected }));
  fresh.add(path);
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

async function packages({ from, held = false, base = '' }, progress) {
  if (held) return replay(from, progress, base);
  return navigator.locks.request('slicc-packages', () => replay(from, progress, base));
}

const ROOTED = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'];

async function project(from, base) {
  if (!base) return install({ from, files: ['package.json', 'pnpm-lock.yaml'] }, () => {});
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
  await install({ from, to: `${base}/`, files }, () => {});
  for (const name of ROOTED) await remove(name);
}

async function outcome(ledger, prefix, task) {
  const { appendLog, described } = await import(INTEGRITY);
  let result;
  try {
    result = await task();
  } catch (error) {
    for (const entry of await ledger.fail(prefix))
      await appendLog(root, described(entry, 'failed'));
    throw error;
  }
  const healed = await ledger.heal(prefix);
  for (const entry of healed) await appendLog(root, described(entry, 'restored'));
  const stopped = await ledger.stopped(prefix);
  return { ...result, repaired: healed.map(({ path }) => path), stopped };
}

async function replay(from, progress, base) {
  const ledger = await integrity();
  return outcome(ledger, '/node_modules/', async () => {
    const lock = JSON.parse(new TextDecoder().decode(await download(from)));
    const queue = Object.entries(lock.packages).filter(
      ([path, entry]) => path && entry.resolved && !entry.os && !entry.cpu
    );
    const removed = await prune(new Set(queue.map(([path]) => path)));
    const tampered = (await ledger.tampered()).filter((path) => path.startsWith('/node_modules/'));
    const names = queue.map(([path]) => path);
    const changed = new Set(tampered.map((path) => owner(path, names)).filter(Boolean));
    const total = queue.length;
    let done = 0;
    let downloaded = 0;
    let bytes = 0;
    const stamps = [];
    const fresh = new Set();
    const entries = [...queue];
    let failure = null;
    const worker = async () => {
      while (queue.length && !failure) {
        const entry = queue.shift();
        try {
          const size = await add(entry, changed, stamps, fresh);
          done += 1;
          downloaded += size ? 1 : 0;
          bytes += size;
          progress({ done, total, path: entry[0] });
        } catch (error) {
          failure ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (failure) {
      if (await stamp(stamps)) await marked([...fresh]);
      throw failure;
    }
    if (await stamp(stamps)) await marked([...fresh]);
    const restamped = await repair(entries, fresh);
    const deployed = new URL('./', from);
    await project(deployed, base);
    await install({ from: deployed, to: 'var/lib/slicc/', files: ['pnpm-lock.yaml'] }, () => {});
    await ledger.bump('node_modules');
    return { packages: total, downloaded, removed, bytes, restamped: restamped.length };
  });
}

async function copy({ from, to, files }, progress, keep = new Set()) {
  const { sha256 } = await import(INTEGRITY);
  let bytes = 0;
  const hashed = [];
  for (const file of files) {
    const data = await download(new URL(file, from));
    if (!keep.has(`/${to}${file}`)) await save(to + file, data);
    hashed.push({ path: `/${to}${file}`, size: data.byteLength, sha256: await sha256(data) });
    bytes += data.byteLength;
    progress({ file, bytes });
  }
  return { bytes, hashed };
}

async function install({ from, to = '', files, source = null }, progress) {
  if (!source) {
    const { bytes } = await copy({ from, to, files }, progress);
    return { files: files.length, bytes };
  }
  const ledger = await integrity();
  return outcome(ledger, `/${to}`, async () => {
    const keep = new Set(await ledger.stopped(`/${to}`));
    const { bytes, hashed } = await copy({ from, to, files }, progress, keep);
    await stamp(
      hashed
        .filter(({ path }) => !keep.has(path))
        .map(({ path }) => ({ path, mode: 0o644, uid: 0, gid: 0 }))
    );
    await ledger.record(source, hashed);
    await ledger.bump(source);
    return { files: files.length, bytes };
  });
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
