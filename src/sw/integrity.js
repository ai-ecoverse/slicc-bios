export const DB = 'slicc-bios-integrity';
export const TREES = ['os', 'node_modules'];
export const LOG = 'var/log/slicc/integrity.log';
export const WINDOW = 10 * 60 * 1000;
export const RECENT = 60 * 1000;

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? lost());
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    const failed = () => reject(transaction.error ?? lost());
    transaction.onerror = failed;
    transaction.onabort = failed;
  });
}

function lost() {
  return new DOMException(
    'the integrity ledger lost its IndexedDB connection',
    'InvalidStateError'
  );
}

function opened(factory) {
  const request = factory.open(DB, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('files', { keyPath: 'path' }).createIndex('source', 'source');
    db.createObjectStore('sources', { keyPath: 'source' });
    db.createObjectStore('trees', { keyPath: 'tree' });
    db.createObjectStore('tampered', { keyPath: 'path' });
  };
  return done(request);
}

const LOST = new Set(['InvalidStateError', 'UnknownError']);

export function reconnecting(open) {
  let current = null;
  const closed = new WeakSet();
  const forget = (attempt, db) => {
    closed.add(db);
    if (current === attempt) current = null;
  };
  const connect = () => {
    if (current) return current;
    const attempt = open().then((db) => {
      db.addEventListener?.('close', () => forget(attempt, db));
      db.addEventListener?.('versionchange', () => {
        forget(attempt, db);
        db.close();
      });
      return db;
    });
    current = attempt;
    attempt.catch(() => {
      if (current === attempt) current = null;
    });
    return attempt;
  };
  return async (task) => {
    const attempt = connect();
    const db = await attempt;
    try {
      return await task(db);
    } catch (error) {
      if (!closed.has(db) && !LOST.has(error?.name)) throw error;
      forget(attempt, db);
      try {
        db.close();
      } catch {}
      return task(await connect());
    }
  };
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
  const using = reconnecting(() => opened(factory));
  return using(() => {}).then(() => createIntegrity(using));
}

export function createIntegrity(connection) {
  const using = typeof connection === 'function' ? connection : (task) => task(connection);
  const get = (store, key) =>
    using((db) => done(db.transaction(store).objectStore(store).get(key)));
  const all = (store) => using((db) => done(db.transaction(store).objectStore(store).getAll()));
  async function drop(files, source) {
    const keys = await done(files.index('source').getAllKeys(source));
    for (const key of keys) files.delete(key);
  }
  return {
    lookup: (path) => get('files', path),
    source: (source) => get('sources', source),
    files: (source) =>
      using((db) =>
        done(db.transaction('files').objectStore('files').index('source').getAll(source))
      ),
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
    record(source, entries, integrity = null) {
      return using(async (db) => {
        const transaction = db.transaction(['files', 'sources'], 'readwrite');
        const files = transaction.objectStore('files');
        await drop(files, source);
        for (const entry of entries) files.put({ ...entry, source });
        transaction.objectStore('sources').put({ source, integrity });
        await finished(transaction);
      });
    },
    forget(source) {
      return using(async (db) => {
        const transaction = db.transaction(['files', 'sources'], 'readwrite');
        await drop(transaction.objectStore('files'), source);
        transaction.objectStore('sources').delete(source);
        await finished(transaction);
      });
    },
    bump(tree) {
      return using(async (db) => {
        const transaction = db.transaction('trees', 'readwrite');
        const trees = transaction.objectStore('trees');
        const generation = ((await done(trees.get(tree)))?.generation ?? 0) + 1;
        trees.put({ tree, generation });
        await finished(transaction);
        return generation;
      });
    },
    tamper(path, { expected = null, actual = null } = {}, now = Date.now()) {
      return using(async (db) => {
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
      });
    },
    heal(prefix, now = Date.now()) {
      return using(async (db) => {
        const transaction = db.transaction('tampered', 'readwrite');
        const store = transaction.objectStore('tampered');
        const healed = (await done(store.getAll())).filter((entry) => due(entry, prefix, now));
        for (const entry of healed) {
          store.put({ ...entry, open: false, stopped: false, restoredAt: now });
        }
        await finished(transaction);
        return healed;
      });
    },
    fail(prefix, now = Date.now()) {
      return using(async (db) => {
        const transaction = db.transaction('tampered', 'readwrite');
        const store = transaction.objectStore('tampered');
        const failed = (await done(store.getAll())).filter((entry) => due(entry, prefix, now));
        for (const entry of failed) store.put({ ...entry, stopped: true, at: now });
        await finished(transaction);
        return failed;
      });
    },
  };
}
