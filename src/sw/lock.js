import { sha256 } from './integrity.js';

export const BROWSERS = 'node_modules/@ai-ecoverse/slicc-browsers';
export const LOCK_CACHE = 'slicc-bios-release-lock';
const ID = /^[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
export class UnusableLock extends Error {
  constructor() {
    super('seven’s release lock is unavailable');
  }
}
const unavailable = () => new UnusableLock();

export function lockPin(lock) {
  const pin = lock?.packages?.[BROWSERS]?.integrity;
  if (typeof pin !== 'string' || !SHA512.test(pin)) throw unavailable();
  return pin;
}

export function lockKey(script, name) {
  const key = new URL(script);
  key.searchParams.set('seven-lock', name);
  return key.href;
}

async function readJson(cache, key) {
  const response = await cache.match(key);
  if (response) return parse(await response.text());
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable();
  }
}

function validPointer(pointer) {
  return (
    typeof pointer?.id === 'string' &&
    ID.test(pointer.id) &&
    typeof pointer.digest === 'string' &&
    SHA256.test(pointer.digest)
  );
}

export function releaseLock(script) {
  const key = (name) => lockKey(script, name);
  const active = key('active');
  const staged = key('staged');
  const activating = key('activating');
  let installed;
  let adopted;

  const copy = async (cache, pointer) => {
    if (!validPointer(pointer)) throw unavailable();
    const response = await cache.match(key(pointer.id));
    if (!response) throw unavailable();
    const bytes = await response.arrayBuffer();
    if ((await sha256(bytes)) !== pointer.digest) throw unavailable();
    const saved = parse(new TextDecoder().decode(bytes));
    if (
      saved?.id !== pointer.id ||
      saved.script !== script ||
      typeof saved.pin !== 'string' ||
      !SHA512.test(saved.pin)
    )
      throw unavailable();
    return saved.pin;
  };

  return {
    async install() {
      adopted = false;
      const response = await fetch(new URL('packages/package-lock.json', script), {
        cache: 'no-cache',
        mode: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw unavailable();
      const pin = lockPin(await response.json());
      const id = crypto.randomUUID();
      const bytes = new TextEncoder().encode(JSON.stringify({ id, script, pin }));
      const pointer = { id, digest: await sha256(bytes) };
      const cache = await caches.open(LOCK_CACHE);
      await cache.put(key(id), new Response(bytes));
      await cache.put(staged, Response.json(pointer));
      installed = id;
    },
    async activate() {
      adopted = false;
      const cache = await caches.open(LOCK_CACHE);
      await cache.put(activating, new Response());
      const previous = await readJson(cache, active).catch(() => null);
      const pointer = await readJson(cache, staged);
      await copy(cache, pointer);
      if ((installed && pointer.id !== installed) || pointer.id === previous?.id)
        throw unavailable();
      await cache.put(active, Response.json(pointer));
      await cache.delete(activating);
      adopted = pointer.id;
      if (validPointer(previous)) await cache.delete(key(previous.id)).catch(() => false);
    },
    async pin() {
      if (adopted === false) throw unavailable();
      const cache = await caches.open(LOCK_CACHE);
      const pointer = await readJson(cache, active);
      if (pointer === undefined) return null;
      if (await cache.match(activating)) throw unavailable();
      if (adopted && pointer?.id !== adopted) throw unavailable();
      return copy(cache, pointer);
    },
  };
}
