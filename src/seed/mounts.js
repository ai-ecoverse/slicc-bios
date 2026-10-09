import { attachKernel } from '@ai-ecoverse/slicc-kernel';

export const KEY = 'slicc-os.mounts';
const FOLDERS = new Set(['fsa', 'hostfs']);
const SKIP = new Set(['node_modules', '.git']);
const LIMIT = 5000;
const SETTLE_MS = 16000;
const STEP_MS = 250;
const POLL_MS = 10000;

const under = (path, target) => path.startsWith(`${target}/`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const folders = (table) => table.filter((entry) => FOLDERS.has(entry.type));
const same = (a, b) => a.target === b.target && a.source === b.source;

export async function offTheRecord(storage = navigator.storage, memory = performance.memory) {
  if ((await storage.persisted?.()) !== true) return true;
  const { quota } = await storage.estimate();
  return quota < (memory?.jsHeapSizeLimit ?? 2 ** 30) * 2;
}

export function hostfsGrants(proxy, fetcher = fetch) {
  return async (source, { readonly }) => {
    const response = await fetcher(new URL('/api/hostfs/grant', proxy.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': proxy.key },
      body: JSON.stringify({ mount: source, readonly }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        body.message ?? `the local proxy has no folder ${source} (${response.status})`
      );
    }
    return { url: proxy.url, token: body.token, capabilities: body.capabilities };
  };
}

export function hostfsExports(proxy, fetcher = fetch) {
  return async () => {
    const response = await fetcher(new URL('/api/hostfs/mounts', proxy.url), {
      method: 'POST',
      headers: { 'X-Bridge-Token': proxy.key },
    });
    if (!response.ok) return [];
    const list = await response.json().catch(() => []);
    return Array.isArray(list) ? list.map((entry) => entry.name) : [];
  };
}

export function remembered(storage, secret) {
  let list = [];
  try {
    list = JSON.parse(storage.getItem(KEY) ?? '[]');
  } catch {}
  return Array.isArray(list) ? list.filter((entry) => !secret || entry.type !== 'fsa') : [];
}

export function remember(storage, secret, previous, next) {
  let list = remembered(storage, secret).filter(
    (entry) => !previous.some((old) => same(old, entry) && !next.some((now) => same(now, old)))
  );
  for (const entry of next) {
    if (secret && entry.type === 'fsa') continue;
    if (previous.some((old) => same(old, entry))) continue;
    const { type, source, target, options } = entry;
    list = [...list.filter((old) => old.target !== target), { type, source, target, options }];
  }
  storage.setItem(KEY, JSON.stringify(list));
}

async function walk(fs, path, out) {
  for (const name of await fs.readdir(path)) {
    if (out.length >= LIMIT) return;
    const child = `${path}/${name}`;
    const stat = await fs.stat(child).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory) {
      out.push({ path: child, kind: 'directory', size: 0, modified: 0 });
      if (!SKIP.has(name)) await walk(fs, child, out).catch(() => {});
    } else {
      out.push({ path: child, kind: 'file', size: stat.size, modified: +stat.mtime });
    }
  }
}

export async function walkMounts(fs, table) {
  const out = [];
  for (const entry of folders(table)) {
    if (entry.state === 'ok') await walk(fs, entry.target, out).catch(() => {});
  }
  return out;
}

export function mountName(name, taken) {
  const base = name.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '') || 'folder';
  let target = `/mnt/${base}`;
  for (let n = 2; taken.has(target); n++) target = `/mnt/${base}-${n}`;
  return target;
}

export function pendingNotice(app, { target, insert, done, session }) {
  const notice = document.createElement('span');
  notice.slot = 'status';
  notice.className = 'mount';
  notice.dataset.target = target;
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const output = document.createElement('output');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Insert folder';
  const say = (text, state = 'pending') => {
    notice.dataset.state = state;
    notice.title = text;
    output.value = text;
  };
  say(
    session ? `${target} needs a folder (asked again after a reload)` : `${target} needs a folder`
  );
  button.addEventListener('click', () => {
    const inserting = insert();
    button.disabled = true;
    void inserting.then(
      () => done(),
      (error) => {
        button.disabled = false;
        if (error?.name === 'AbortError') return;
        say(`no folder for ${target}: ${error?.message ?? error}`, 'failed');
      }
    );
  });
  notice.append(output, button);
  app.append(notice);
  return () => notice.remove();
}

async function settle(kernel, before, update) {
  const was = JSON.stringify(before);
  for (const end = Date.now() + SETTLE_MS; Date.now() < end; await pause(STEP_MS)) {
    const next = await kernel.mounts();
    if (JSON.stringify(next) !== was) return update(next);
  }
}

function kernelOptions({ secret, pick, pending, allow, network }) {
  return {
    ...(secret ? { media: false } : {}),
    requestDirectory: () => pick(),
    onMountPending: pending,
    processMounts: allow,
    ...(network.kind === 'local-proxy' ? { hostfs: hostfsGrants(network.proxy) } : {}),
  };
}

function markFolders(session) {
  document.documentElement.dataset.folders = session ? 'session' : 'remembered';
}

export function createFolders({
  app,
  storage,
  network,
  secret: initial = false,
  pick = () => showDirectoryPicker({ mode: 'readwrite' }),
  persist = () => navigator.storage.persist?.(),
  check = offTheRecord,
  mark = markFolders,
  notice = pendingNotice,
  attach = attachKernel,
}) {
  let secret = initial;
  mark(secret);
  const exports = network.kind === 'local-proxy' ? hostfsExports(network.proxy) : null;
  const listeners = new Map();
  const notices = new Map();
  const inserting = new Set();
  let kernel = null;
  let fs = null;
  let files = null;
  let table = [];
  let entries = [];
  let running = null;
  let again = false;
  let forced = false;

  const emit = (type, detail) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(detail);
  };
  const mounted = () => folders(table).map((entry) => entry.target);
  const inside = (path) => mounted().some((target) => under(path, target));

  async function scan() {
    const out = await walkMounts(fs, table);
    const changed = JSON.stringify(out) !== JSON.stringify(entries);
    entries = out;
    return changed;
  }

  async function list() {
    const listed = (await files.list()).filter((entry) => !inside(entry.path));
    return [...listed, ...entries].sort((a, b) => a.path.localeCompare(b.path));
  }

  function refresh(force = false) {
    forced ||= force;
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        if ((await scan()) || forced) {
          forced = false;
          emit('files', await list());
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  async function update(next) {
    const previous = folders(table);
    table = next;
    remember(storage, secret, previous, folders(next));
    for (const [target, dismiss] of notices) {
      const entry = next.find((mount) => mount.target === target);
      if (entry?.state !== 'nomedium') {
        dismiss();
        notices.delete(target);
      }
    }
    emit('mounts', mounted());
    await refresh(true);
  }

  async function upgrade() {
    if (!secret || !(await persist()) || (await check())) return;
    secret = false;
    mark(secret);
    remember(storage, secret, [], folders(table));
  }

  function pending({ target, source, insert }) {
    if (inserting.has(target)) return;
    notices.get(target)?.();
    notices.set(
      target,
      notice(app, {
        target,
        source,
        session: secret,
        insert: () => {
          const inserted = insert();
          void upgrade().catch(() => {});
          return inserted;
        },
        done: () => void kernel.mounts().then(update),
      })
    );
  }

  async function allow(req) {
    const hostfs = req.op === 'mount' && req.type === 'hostfs' && exports;
    if (hostfs && !(await exports()).includes(req.source)) return false;
    void settle(kernel, await kernel.mounts(), update);
    return true;
  }

  const port = {
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
    list,
    read: (path) => (inside(path) ? fs.readText(path) : files.read(path)),
    async write(path, text, agentId) {
      if (!inside(path)) return files.write(path, text, agentId);
      await fs.writeFile(path, text);
      await refresh();
      emit('file', path);
    },
    async remove(path, agentId) {
      if (!inside(path)) return files.remove(path, agentId);
      await fs.rm(path);
      await refresh();
    },
    changes: () => files.changes(),
    accept: (path) => files.accept(path),
    revert: (path) => files.revert(path),
    mounts: mounted,
    async mountFolder() {
      let handle;
      try {
        handle = await pick();
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        throw error;
      }
      const target = mountName(handle.name, new Set(table.map((entry) => entry.target)));
      await fs.mkdir(target);
      inserting.add(target);
      try {
        await kernel.mount({ type: 'fsa', source: 'none', target });
        await kernel.insert(target, handle);
      } finally {
        inserting.delete(target);
      }
      await update(await kernel.mounts());
      return target;
    },
    async eject(path) {
      await kernel.umount(path);
      await update(await kernel.mounts());
    },
  };

  return {
    options: kernelOptions({ secret: initial, pick, pending, allow, network }),
    async attach(attached, model) {
      kernel = attached;
      files = model.files;
      fs = (await attach(await kernel.connect())).fs;
      files.on('files', () => void list().then((all) => emit('files', all)));
      files.on('file', (path) => emit('file', path));
      files.on('changes', (changes) => emit('changes', changes));
      await fs
        .watch(['/'], { recursive: true }, ({ paths, overflow }) => {
          if (overflow || paths.some(inside)) void refresh();
        })
        .catch(() => {});
      setInterval(() => void refresh(), POLL_MS);
      return { ...model, files: port };
    },
    async restore() {
      for (const { type, source, target, options } of remembered(storage, secret)) {
        try {
          await fs.mkdir(target);
          await kernel.mount({ type, source, target, options });
        } catch (error) {
          console.warn(`${target} was not mounted again: ${error.message}`);
        }
      }
      await update(await kernel.mounts());
    },
  };
}
