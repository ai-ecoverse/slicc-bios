export const INVENTORY_KEY = 'slicc-os.inventory';
export const THROTTLE_MS = 250;
export const REPEAT_MS = 30000;

const STATUSES = ['running', 'queued', 'waiting', 'error', 'idle'];
const encoder = new TextEncoder();

export const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const minted = (random) => base64url(random(new Uint8Array(16)));

const valid = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);

export function instanceOf(
  storage = globalThis.localStorage,
  random = (bytes) => crypto.getRandomValues(bytes)
) {
  let kept = null;
  try {
    kept = JSON.parse(storage?.getItem(INVENTORY_KEY) ?? 'null');
  } catch {}
  if (valid(kept?.id) && valid(kept?.key)) return kept;
  const made = { id: minted(random), key: minted(random) };
  try {
    storage?.setItem(INVENTORY_KEY, JSON.stringify(made));
  } catch {}
  return made;
}

const bytesOf = (text) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

export function hasher(key, subtle = crypto.subtle) {
  const imported = subtle.importKey('raw', bytesOf(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const known = new Map();
  return async (id) => {
    if (!known.has(id)) {
      const mac = await subtle.sign('HMAC', await imported, encoder.encode(id));
      known.set(id, base64url(new Uint8Array(mac).slice(0, 16)));
    }
    return known.get(id);
  };
}

const named = () =>
  globalThis.location?.host ? `seven on ${globalThis.location.host}` : undefined;

export function inventoryIdentity({ name = named(), storage, random, subtle } = {}) {
  let known = null;
  return async () => {
    if (!known) {
      const kept = instanceOf(storage, random);
      known = { instance: { id: kept.id, name }, hash: hasher(kept.key, subtle) };
    }
    return known;
  };
}

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const text = (value) => (typeof value === 'string' && value ? value : undefined);

export async function shaped(snapshot, { instance, hash, now }) {
  const agents = await Promise.all(
    (snapshot?.agents ?? [])
      .filter((agent) => typeof agent?.id === 'string' && STATUSES.includes(agent.status))
      .map(async (agent) => {
        const parent = text(agent.parent);
        const provider = text(agent.provider);
        const model = provider && text(agent.model);
        return {
          id: await hash(agent.id),
          kind: agent.kind === 'scoop' ? 'scoop' : 'cone',
          ...(parent ? { parent: await hash(parent) } : {}),
          status: agent.status,
          queued: count(agent.queued),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          since: count(agent.since),
        };
      })
  );
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const agent of agents) counts[agent.status] += 1;
  return {
    v: 1,
    instance: { id: instance.id, ...(instance.name ? { name: instance.name } : {}) },
    seq: count(snapshot?.seq),
    changedAt: count(snapshot?.changedAt),
    reportedAt: now(),
    counts,
    agents,
  };
}

export async function followInventory(stream, first, events, { render, line, now, timers }) {
  const iterator = events[Symbol.asyncIterator]();
  let gone = false;
  let latest = first;
  let sentAt = now();
  let flush = null;
  let repeat = null;
  let writing = Promise.resolve();
  const send = () => {
    flush = null;
    if (gone) return;
    sentAt = now();
    const snapshot = latest;
    writing = writing
      .then(async () => {
        if (gone) return;
        await stream.write(line({ t: 'inventory', ...(await render(snapshot)) }));
      })
      .catch(() => {
        stop();
      });
    timers.clear(repeat);
    repeat = timers.set(send, REPEAT_MS);
  };
  const stop = () => {
    if (gone) return;
    gone = true;
    timers.clear(flush);
    timers.clear(repeat);
    void iterator.return?.();
  };
  const watching = (async () => {
    try {
      while ((await stream.read()) !== null);
      if (!(await stream.settled)) return;
    } catch {}
    stop();
  })();
  void watching;
  repeat = timers.set(send, REPEAT_MS);
  try {
    for (let next = await iterator.next(); !next.done && !gone; next = await iterator.next()) {
      latest = next.value;
      if (flush !== null) continue;
      const wait = sentAt + THROTTLE_MS - now();
      if (wait <= 0) send();
      else flush = timers.set(send, wait);
    }
  } catch {}
  const ended = !gone;
  stop();
  await writing;
  if (ended) stream.closeWrite();
}
