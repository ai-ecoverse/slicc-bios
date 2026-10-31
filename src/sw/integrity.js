export const DB = 'slicc-bios-integrity';
export const TREES = ['os', 'node_modules'];
export const LOG = 'var/log/slicc/integrity.log';
export const WINDOW = 10 * 60 * 1000;
export const RECENT = 60 * 1000;

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function treeOf(path) {
  return TREES.find((tree) => path.startsWith(`/${tree}/`));
}

export async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const NOTICES = 'slicc-kernel-dirs:slicc-kernel';

export function written(path) {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, at) => `/${parts.slice(0, at + 1).join('/')}`);
}

export function postNotice({ paths = [], trees = [] }) {
  if (!paths.length && !trees.length) return;
  const channel = new BroadcastChannel(NOTICES);
  try {
    channel.postMessage({ paths: [...paths], trees: [...trees] });
  } finally {
    channel.close();
  }
}

export async function appendLog(root, event, now = Date.now()) {
  const names = LOG.split('/');
  const name = names.pop();
  let dir = await root;
  for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  const { size } = await handle.getFile();
  const writable = await handle.createWritable({ keepExistingData: true });
  await writable.seek(size);
  await writable.write(`${JSON.stringify({ time: new Date(now).toISOString(), ...event })}\n`);
  await writable.close();
  postNotice({ paths: written(LOG) });
}

export function described(entry, event) {
  const { path, expected, actual, at } = entry;
  return { event, path, expected, actual, changed: new Date(at).toISOString() };
}

function due(entry, prefix, now) {
  return (
    entry.open && entry.path.startsWith(prefix) && (!entry.stopped || now - entry.at >= WINDOW)
  );
}

export function openIntegrity(factory = indexedDB) {
  const request = factory.open(DB, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('files', { keyPath: 'path' }).createIndex('source', 'source');
    db.createObjectStore('sources', { keyPath: 'source' });
    db.createObjectStore('trees', { keyPath: 'tree' });
    db.createObjectStore('tampered', { keyPath: 'path' });
  };
  return done(request).then(createIntegrity);
}

export function createIntegrity(db) {
  const get = (store, key) => done(db.transaction(store).objectStore(store).get(key));
  const all = (store) => done(db.transaction(store).objectStore(store).getAll());
  async function drop(files, source) {
    const keys = await done(files.index('source').getAllKeys(source));
    for (const key of keys) files.delete(key);
  }
  return {
    lookup: (path) => get('files', path),
    source: (source) => get('sources', source),
    files: (source) =>
      done(db.transaction('files').objectStore('files').index('source').getAll(source)),
    generation: async (tree) => (await get('trees', tree))?.generation ?? 0,
    tampered: async (now = Date.now()) =>
      (await all('tampered')).filter((entry) => due(entry, '/', now)).map(({ path }) => path),
    stopped: async (prefix = '/', now = Date.now()) =>
      (await all('tampered'))
        .filter((entry) => entry.open && entry.stopped && entry.path.startsWith(prefix))
        .filter((entry) => !due(entry, prefix, now))
        .map(({ path }) => path),
    status: async (now = Date.now()) => {
      const open = (await all('tampered')).filter((entry) => entry.open);
      return {
        stopped: open
          .filter((entry) => entry.stopped && !due(entry, '/', now))
          .map(({ path }) => path),
        changed: open.map(({ path }) => path),
      };
    },
    async record(source, entries, integrity = null) {
      const transaction = db.transaction(['files', 'sources'], 'readwrite');
      const files = transaction.objectStore('files');
      await drop(files, source);
      for (const entry of entries) files.put({ ...entry, source });
      transaction.objectStore('sources').put({ source, integrity });
      await finished(transaction);
    },
    async forget(source) {
      const transaction = db.transaction(['files', 'sources'], 'readwrite');
      await drop(transaction.objectStore('files'), source);
      transaction.objectStore('sources').delete(source);
      await finished(transaction);
    },
    async bump(tree) {
      const transaction = db.transaction('trees', 'readwrite');
      const trees = transaction.objectStore('trees');
      const generation = ((await done(trees.get(tree)))?.generation ?? 0) + 1;
      trees.put({ tree, generation });
      await finished(transaction);
      return generation;
    },
    async tamper(path, { expected = null, actual = null } = {}, now = Date.now()) {
      const transaction = db.transaction('tampered', 'readwrite');
      const store = transaction.objectStore('tampered');
      const old = await done(store.get(path));
      if (old?.open && (!old.stopped || now - old.at < WINDOW)) {
        await finished(transaction);
        return { fresh: false, stopped: old.stopped, entry: old };
      }
      const seen = [...(old?.seen ?? []).filter((at) => now - at < WINDOW), now];
      const restoredAt = old?.restoredAt ?? null;
      const stopped = seen.length >= 3 || (restoredAt !== null && now - restoredAt < RECENT);
      const entry = { path, open: true, stopped, seen, at: now, expected, actual, restoredAt };
      store.put(entry);
      await finished(transaction);
      return { fresh: true, stopped, entry };
    },
    async heal(prefix, now = Date.now()) {
      const transaction = db.transaction('tampered', 'readwrite');
      const store = transaction.objectStore('tampered');
      const healed = (await done(store.getAll())).filter((entry) => due(entry, prefix, now));
      for (const entry of healed) {
        store.put({ ...entry, open: false, stopped: false, restoredAt: now });
      }
      await finished(transaction);
      return healed;
    },
    async fail(prefix, now = Date.now()) {
      const transaction = db.transaction('tampered', 'readwrite');
      const store = transaction.objectStore('tampered');
      const failed = (await done(store.getAll())).filter((entry) => due(entry, prefix, now));
      for (const entry of failed) store.put({ ...entry, stopped: true, at: now });
      await finished(transaction);
      return failed;
    },
  };
}
