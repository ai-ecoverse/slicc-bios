export const DB = 'slicc-bios-integrity';
export const TREES = ['os', 'node_modules'];

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
    tampered: async () => (await all('tampered')).map(({ path }) => path),
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
    async tamper(path) {
      const transaction = db.transaction('tampered', 'readwrite');
      transaction.objectStore('tampered').put({ path, at: Date.now() });
      await finished(transaction);
    },
    async heal(prefix) {
      const transaction = db.transaction('tampered', 'readwrite');
      const store = transaction.objectStore('tampered');
      const paths = (await done(store.getAllKeys())).filter((path) => path.startsWith(prefix));
      for (const path of paths) store.delete(path);
      await finished(transaction);
      return paths;
    },
  };
}
