import { certificate, dial, dropCertificate, hubOrigin, hubs, joinUrl, sleep } from './follow.js';
import { failure } from './link.js';
import { FOLLOWER } from './tray.js';

export const LEADERS_KEY = 'slicc-os.leaders';
export const KEPT = 16;
export const IDLE_MS = 10 * 60 * 1000;
export const DIAL_MS = 45_000;
const BACKOFF = [1_000, 2_000, 5_000];
export const ELSEWHERE = "EACCES: that join URL isn't on a tray hub this seven links through";
export const UNREACHABLE = "ENOTCONN: couldn't reach that seven through its tray";
export const NO_CONTROL =
  "EACCES: that seven doesn't allow remote control from this one; turn it on in its Linked devices";
const REFUSED = {
  UNLINKED: 'that seven unlinked this one; run slicc again to link as a new device',
  INVALID_JOIN_CAPABILITY: "the tray hub doesn't know that join URL",
  TRAY_EXPIRED: 'that tray has expired; ask for a new join URL',
};

export const certificateKey = (hub) => `link:${hub}`;

export const proxyOf = (hub, page) => (hub === page ? hub : null);

export async function joinKey(url, subtle = crypto.subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function readLeaders(storage) {
  try {
    const kept = JSON.parse(storage.getItem(LEADERS_KEY));
    return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
  } catch {
    return {};
  }
}

function writeLeaders(storage, kept) {
  const newest = Object.entries(kept)
    .sort(([, a], [, b]) => (b?.at ?? 0) - (a?.at ?? 0))
    .slice(0, KEPT);
  if (newest.length) storage.setItem(LEADERS_KEY, JSON.stringify(Object.fromEntries(newest)));
  else storage.removeItem(LEADERS_KEY);
}

function refusal(error) {
  if (error.unlinked) return failure(`EACCES: ${REFUSED.UNLINKED}`);
  if (error.gone)
    return failure(`EACCES: ${REFUSED[error.code] ?? `that seven's tray refused (${error.code})`}`);
  return error.code === 'EACCES' ? error : failure(UNREACHABLE);
}

const refusedByLeader = (error) =>
  error.code === 'EACCES' && error.message === 'EACCES' ? failure(NO_CONTROL) : error;

export function createLeaders({
  storage = localStorage,
  post,
  makePeer = (config) => new RTCPeerConnection(config),
  name,
  cert = (hub) => certificate(certificateKey(hub)),
  forget = (hub) => dropCertificate(certificateKey(hub)),
  timers = globalThis,
  now = Date.now,
  newId = () => crypto.randomUUID(),
  digest = joinKey,
}) {
  const entries = new Map();

  const remember = (entry) => {
    const kept = readLeaders(storage);
    kept[entry.key] = {
      hub: entry.hub,
      ...(entry.current === entry.given ? {} : { url: entry.current }),
      at: now(),
    };
    writeLeaders(storage, kept);
  };

  async function unlinked(hub) {
    const kept = readLeaders(storage);
    for (const [key, item] of Object.entries(kept)) if (item?.hub === hub) delete kept[key];
    writeLeaders(storage, kept);
    for (const entry of entries.values()) if (entry.hub === hub) entry.current = entry.given;
    await forget(hub).catch(() => undefined);
  }

  function idle(entry) {
    timers.clearTimeout(entry.idle);
    if (!entry.ready) {
      entries.delete(entry.key);
      return;
    }
    entry.idle = timers.setTimeout(() => {
      if (entry.uses) return;
      entries.delete(entry.key);
      entry.link?.close('idle');
    }, IDLE_MS);
  }

  async function connect(entry) {
    const stop = new Set();
    let over = false;
    let made = null;
    let timer = null;
    const expired = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        over = true;
        for (const wake of [...stop]) wake();
        made?.close('gave up');
        reject(failure(UNREACHABLE));
      }, DIAL_MS);
    });
    expired.catch(() => undefined);
    const ctx = {
      hub: entry.hub,
      runtime: FOLLOWER,
      post,
      makePeer,
      cert: () => cert(entry.hub),
      hello: () => ({ name, mode: 'remote', node: newId(), caps: [] }),
      timers,
      now,
      url: () => entry.current,
      keep: (next) => {
        entry.current = next;
        remember(entry);
      },
      over: () => over,
      nap: (ms) => sleep(timers, ms, stop),
      waiting: () => undefined,
      adopt: (link) => {
        made = link;
      },
      accept: () => Promise.reject(failure('EACCES')),
    };
    try {
      for (let attempt = 0; !over; attempt += 1) {
        try {
          const { linked, ended } = await dial(ctx, newId());
          const session = await Promise.race([linked, expired]);
          const link = made;
          entry.link = link;
          void ended.then(() => {
            if (entry.link !== link) return;
            entry.link = null;
            entry.ready = null;
            if (!entry.uses) idle(entry);
          });
          remember(entry);
          return session;
        } catch (error) {
          made?.close('gave up');
          if (error.unlinked) await unlinked(entry.hub);
          if (over || error.unlinked || error.gone || error.code === 'EACCES') throw refusal(error);
          await ctx.nap(BACKOFF[Math.min(attempt, BACKOFF.length - 1)]);
        }
      }
      throw failure(UNREACHABLE);
    } finally {
      over = true;
      timers.clearTimeout(timer);
    }
  }

  async function open(join, meta) {
    const allowed = hubs(storage);
    const url = joinUrl(join, allowed);
    if (!url || !allowed.includes(hubOrigin(url))) throw failure(ELSEWHERE);
    const key = await digest(url);
    let entry = entries.get(key);
    if (!entry) {
      const hub = hubOrigin(url);
      const kept = readLeaders(storage)[key];
      const moved = kept?.hub === hub ? joinUrl(kept.url, allowed) : null;
      entry = {
        key,
        hub,
        given: url,
        current: moved && hubOrigin(moved) === hub ? moved : url,
        uses: 0,
        ready: null,
        link: null,
        idle: null,
      };
      entries.set(key, entry);
    }
    entry.uses += 1;
    timers.clearTimeout(entry.idle);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      entry.uses -= 1;
      if (!entry.uses) idle(entry);
    };
    try {
      entry.ready ??= connect(entry).catch((error) => {
        entry.ready = null;
        throw error;
      });
      const session = await entry.ready;
      if (!session.caps().includes('agent')) {
        entry.link?.close('no remote control');
        throw failure(NO_CONTROL);
      }
      const stream = await session.open(meta).catch((error) => {
        throw refusedByLeader(error);
      });
      return { stream, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  return { open };
}
