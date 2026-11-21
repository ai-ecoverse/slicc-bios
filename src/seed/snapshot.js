import { asker } from './requests.js';

export const SNAPSHOTS_KEY = 'slicc-os.snapshots';
export const MIN_TTL_MS = 60_000;
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FILES = 1000;
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
export const MAX_SNAPSHOT_FILE = 25 * 1024 * 1024;
export const LINE_BYTES = 4096;
export const UPLOADS = 4;
export const SNAPSHOT_DISMISSED = 'the request to publish the snapshot was dismissed';
export const SNAPSHOT_LATE = 'nobody answered the request to publish the snapshot within 60 s';

class Refused extends Error {
  constructor(refused) {
    super(refused.error);
    this.refused = refused;
  }
}

export class BadBody extends Error {
  constructor(what) {
    super(`bad snapshot body: ${what}`);
    this.name = 'BadBody';
  }
}

const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function snapshotOptions(options) {
  const { ttlMs, files, bytes } = options ?? {};
  if (!whole(ttlMs, MIN_TTL_MS, MAX_TTL_MS)) throw new TypeError('invalid ttlMs');
  if (!whole(files, 1, MAX_FILES)) throw new TypeError('invalid files');
  if (!whole(bytes, 0, MAX_SNAPSHOT_BYTES)) throw new TypeError('invalid bytes');
  return { ttlMs, files, bytes };
}

export function snapshotPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) return null;
  if (/[\\:\0]/.test(value) || value.startsWith('/')) return null;
  const parts = value.split('/');
  const bad = (part) =>
    !part || part === '.' || part === '..' || (part.startsWith('.') && part !== '.well-known');
  return parts.some(bad) ? null : value;
}

const TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(\s*;\s*[\w!#$&^.+-]+=("[^"\r\n]*"|[\w!#$&^.+-]+))*$/;

export function snapshotType(value) {
  return typeof value === 'string' && value.length <= 255 && TYPE.test(value) ? value : null;
}

export function bodyReader(body) {
  const reader = body?.getReader?.();
  const chunks = [];
  let held = 0;
  let done = !reader;
  const fill = async () => {
    if (done) return false;
    const read = await reader.read();
    if (read.done) {
      done = true;
      return false;
    }
    if (read.value?.byteLength) {
      chunks.push(read.value);
      held += read.value.byteLength;
    }
    return true;
  };
  const take = (count) => {
    const out = new Uint8Array(count);
    let at = 0;
    while (at < count) {
      const first = chunks[0];
      const need = count - at;
      if (first.byteLength <= need) {
        out.set(first, at);
        at += first.byteLength;
        chunks.shift();
      } else {
        out.set(first.subarray(0, need), at);
        chunks[0] = first.subarray(need);
        at = count;
      }
    }
    held -= count;
    return out;
  };
  const indexOfNewline = () => {
    let offset = 0;
    for (const chunk of chunks) {
      const found = chunk.indexOf(10);
      if (found >= 0) return offset + found;
      offset += chunk.byteLength;
    }
    return -1;
  };
  return {
    async line(max) {
      for (;;) {
        const at = indexOfNewline();
        if (at >= 0 && at <= max) {
          const bytes = take(at + 1);
          return new TextDecoder().decode(bytes.subarray(0, at));
        }
        if (at > max || held > max) throw new BadBody(`a file line longer than ${max} bytes`);
        if (!(await fill())) {
          if (held === 0) return null;
          throw new BadBody('the body ends inside a file line');
        }
      }
    },
    async bytes(count) {
      while (held < count) {
        if (!(await fill())) throw new BadBody('the body ends inside a file');
      }
      return take(count);
    },
    cancel: (reason) => reader?.cancel(reason).catch(() => undefined),
  };
}

export async function* snapshotFiles(reader, { files, bytes }) {
  const seen = new Set();
  let count = 0;
  let total = 0;
  for (;;) {
    const text = await reader.line(LINE_BYTES);
    if (text === null) break;
    let head;
    try {
      head = JSON.parse(text);
    } catch {
      throw new BadBody('a file line that isn’t JSON');
    }
    const path = snapshotPath(head?.path);
    if (!path) throw new BadBody(`the path ${JSON.stringify(head?.path ?? null)}`);
    const type = snapshotType(head.type);
    if (!type) throw new BadBody(`the type of ${path}`);
    if (!whole(head.size, 0, MAX_SNAPSHOT_FILE)) throw new BadBody(`the size of ${path}`);
    if (seen.has(path)) throw new BadBody(`${path} twice`);
    seen.add(path);
    count += 1;
    total += head.size;
    if (count > files) throw new BadBody(`more than the ${files} files it announced`);
    if (total > bytes) throw new BadBody(`more than the ${bytes} bytes it announced`);
    yield { path, type, bytes: await reader.bytes(head.size) };
  }
  if (count !== files || total !== bytes)
    throw new BadBody(
      `${count} files and ${total} bytes, not the ${files} and ${bytes} it announced`
    );
}

export function sized(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(1))} ${units[unit]}`;
}

const SPANS = [
  [24 * 60 * 60 * 1000, 'day'],
  [60 * 60 * 1000, 'hour'],
  [60 * 1000, 'minute'],
];

export function lasting(ms) {
  const [span, name] = SPANS.find(([span]) => ms % span === 0) ?? [60 * 1000, 'minute'];
  const count = Math.round(ms / span);
  return `${count} ${name}${count === 1 ? '' : 's'}`;
}

export function snapshotPrompt({ stamp, options }) {
  const root = typeof options?.root === 'string' && options.root ? options.root : 'a folder';
  const files = `${options.files} ${options.files === 1 ? 'file' : 'files'}`;
  const what = `a snapshot of ${root} (${files}, ${sized(options.bytes)})`;
  const ttl = lasting(options.ttlMs);
  return {
    title: `Publish ${what} at a public URL for ${ttl}?`,
    body: `${asker(stamp)} asks seven to publish ${what} at a public URL. Anyone with the link can open it for ${ttl}, even after seven closes.`,
    action: 'Publish',
    cancel: 'Cancel',
    variant: 'confirmation',
    dismissed: SNAPSHOT_DISMISSED,
    late: SNAPSHOT_LATE,
  };
}

export function snapshotStore({ storage = globalThis.localStorage, now = Date.now } = {}) {
  const load = () => {
    try {
      const kept = JSON.parse(storage.getItem(SNAPSHOTS_KEY) ?? '[]');
      return Array.isArray(kept) ? kept.filter((item) => item?.expiresAt > now()) : [];
    } catch {
      return [];
    }
  };
  const save = (list) => {
    try {
      storage.setItem(SNAPSHOTS_KEY, JSON.stringify(list));
    } catch {}
  };
  return {
    list: load,
    find: (token) => load().find((item) => item.previewToken === token) ?? null,
    add: (item) =>
      save([...load().filter((kept) => kept.previewToken !== item.previewToken), item]),
    remove: (token) => save(load().filter((item) => item.previewToken !== token)),
  };
}

async function minted(tray, refusal, stop, request) {
  const { servedRoot, entryPath, ttlMs } = request;
  const answer = await tray.previews.mint({ servedRoot, entryPath, allowLive: false, ttlMs });
  const refused = refusal(answer);
  if (refused) return { refused: { ...refused, during: 'mint' } };
  const { previewToken, url, uploadToken } = answer.value ?? {};
  if (typeof previewToken === 'string' && typeof url === 'string' && uploadToken)
    return { previewToken, url, uploadToken };
  if (typeof previewToken === 'string') await stop(previewToken);
  throw new Error("the tray hub's mint answer has no previewToken, url or uploadToken");
}

function uploads(tray, refusal, { previewToken, uploadToken }, { counts, progress }) {
  const pending = new Set();
  let failure = null;
  let uploaded = 0;
  const send = async (file) => {
    const refused = refusal(await tray.previews.file({ previewToken, uploadToken, ...file }));
    if (refused) failure ??= new Refused({ ...refused, during: 'upload', path: file.path });
    uploaded += 1;
    progress?.(`uploaded ${uploaded} of ${counts.files} files`);
  };
  const check = () => {
    if (failure) throw failure;
  };
  return {
    async add(file) {
      const sent = send(file)
        .catch((error) => {
          failure ??= error;
        })
        .then(() => pending.delete(sent));
      pending.add(sent);
      if (pending.size >= UPLOADS) await Promise.race(pending);
      check();
    },
    async settle() {
      await Promise.allSettled(pending);
      check();
    },
  };
}

async function finalized(tray, refusal, held) {
  const answer = await tray.previews.finalize(held);
  const refused = refusal(answer);
  if (refused) throw new Refused({ ...refused, during: 'finalize' });
  return typeof answer.value?.url === 'string' ? answer.value.url : held.url;
}

export function publishSnapshot({ tray, refusal, warn = () => {} }) {
  const stop = (previewToken) =>
    tray.previews
      .stop(previewToken)
      .catch((error) => warn(`serve: stopping an unfinished snapshot: ${error.message}`));
  return async (request) => {
    const { body, signal } = request;
    const held = await minted(tray, refusal, stop, request);
    if (held.refused) return held;
    const sending = uploads(tray, refusal, held, request);
    const reader = bodyReader(body);
    try {
      for await (const file of snapshotFiles(reader, request.counts)) {
        if (signal?.aborted) throw signal.reason;
        await sending.add(file);
      }
      await sending.settle();
      if (signal?.aborted) throw signal.reason;
      const url = await finalized(tray, refusal, held);
      if (signal?.aborted) throw signal.reason;
      return { previewToken: held.previewToken, url };
    } catch (error) {
      await sending.settle().catch(() => undefined);
      await reader.cancel(error?.message);
      await stop(held.previewToken);
      if (error instanceof Refused) return { refused: error.refused };
      throw error;
    }
  };
}

export function createSnapshots({ tray, refusal, store, id, now, warn, prefix, publicUrl, ready }) {
  const upload = publishSnapshot({ tray, refusal, warn });
  const visible = (item, uid) => uid === 0 || item.uid === uid;
  return {
    async snapshot({ root, entry, ttlMs, counts, stamp, body, signal, progress }) {
      ready();
      const servedRoot = `${prefix}${id()}`;
      const entryPath = `${servedRoot}/${entry ?? 'index.html'}`;
      const trayId = tray.previews.trayId();
      const done = await upload({ servedRoot, entryPath, ttlMs, counts, body, signal, progress });
      if (done.refused) return done;
      const since = now();
      const item = {
        previewToken: done.previewToken,
        url: publicUrl(done.url, entry !== null),
        ...(root ? { root } : {}),
        ...(entry ? { entry } : {}),
        since,
        mode: 'persistent',
        expiresAt: since + ttlMs,
        uid: stamp?.uid ?? null,
        ...(trayId ? { trayId } : {}),
        ...counts,
      };
      store.add(item);
      return { item };
    },
    list: (uid) =>
      store
        .list()
        .filter((item) => visible(item, uid))
        .map(({ previewToken, url, root, entry, since, mode, expiresAt }) => ({
          previewToken,
          url,
          ...(root ? { root } : {}),
          ...(entry ? { entry } : {}),
          since,
          mode,
          expiresAt,
        })),
    held(token, uid) {
      const item = store.find(token);
      if (!item) return false;
      return visible(item, uid) ? true : null;
    },
    revoked: (token) => store.remove(token),
  };
}
