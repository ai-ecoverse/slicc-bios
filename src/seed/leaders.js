import { certificate, dial, dropCertificate, hubOrigin, hubs, joinUrl, sleep } from './follow.js';
import { failure } from './link.js';
import { displayName, FOLLOWER } from './tray.js';

export const LEADERS_KEY = 'slicc-os.leaders';
export const KEPT = 16;
export const DIAL_MS = 45_000;
export const HIDDEN_MS = 10 * 60 * 1000;
export const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
export const ELSEWHERE = "EACCES: that join URL isn't on a tray hub this seven links through";
export const UNREACHABLE = "ENOTCONN: couldn't reach that seven through its tray";
export const NO_CONTROL =
  "EACCES: that seven doesn't allow remote control from this one; turn it on in its Linked devices";
export const DISCONNECTED =
  'EACCES: this seven disconnected from that one; reconnect it in Network to follow it again';
export const FORGOTTEN = 'ECONNABORTED: this seven forgot that one';
const AWAY = "ENOTCONN: that seven isn't on its tray right now";
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

export function sentence(text) {
  const said = String(text || 'the link failed');
  return `${said[0].toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? '' : '.'}`;
}

export function distinctLeaders(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  return rows.map((row) =>
    counts.get(row.name) > 1 ? { ...row, name: `${row.name} · ${row.id.slice(0, 4)}` } : row
  );
}

function stateOf(entry) {
  if (entry.off) return 'disconnected';
  if (entry.failed) return 'failed';
  if (entry.session) return 'connected';
  return entry.seen ? 'reconnecting' : 'connecting';
}

const wake = (entry) => {
  for (const resume of [...entry.stop]) resume();
};

const drop = (self, entry) => {
  if (self.entries.get(entry.key) === entry) self.entries.delete(entry.key);
};

const settle = (entry, error) => {
  for (const waiter of [...entry.waiters]) waiter.reject(error);
};

function row(entry) {
  const host = new URL(entry.hub).host;
  const state = stateOf(entry);
  return {
    id: entry.key,
    name: displayName(entry.name || host),
    hub: host,
    state,
    ...(state === 'failed' ? { error: entry.failed } : {}),
  };
}

function remember(self, entry) {
  if (self.entries.get(entry.key) !== entry) return;
  const kept = readLeaders(self.storage);
  kept[entry.key] = {
    hub: entry.hub,
    url: entry.current,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.off ? { off: true } : {}),
    at: self.now(),
  };
  writeLeaders(self.storage, kept);
}

function mark(self, entry, extra = { unlinked: true }) {
  const kept = readLeaders(self.storage);
  kept[entry.key] = { hub: entry.hub, ...extra, at: self.now() };
  writeLeaders(self.storage, kept);
}

function make(self, key, url, kept) {
  const hub = hubOrigin(url);
  const same = kept?.hub === hub;
  const live = same && kept.unlinked !== true;
  const moved = live ? joinUrl(kept.url, hubs(self.storage)) : null;
  return {
    key,
    hub,
    given: url,
    current: moved && hubOrigin(moved) === hub ? moved : url,
    name: live && typeof kept.name === 'string' ? kept.name : null,
    known: Boolean(moved),
    off: Boolean(moved) && kept.off === true,
    relink: same && kept.unlinked === true,
    untold: same && kept.unlinked === true && kept.untold === true,
    failed: null,
    session: null,
    link: null,
    abort: null,
    running: false,
    seen: false,
    over: false,
    stop: new Set(),
    waiters: new Set(),
  };
}

function halt(entry, why) {
  entry.over = true;
  entry.abort?.();
  wake(entry);
  entry.link?.close('left');
  entry.link = null;
  entry.session = null;
  settle(entry, failure(why));
}

async function attempt(self, entry) {
  let over = false;
  let made = null;
  let timer = null;
  const expired = new Promise((_, reject) => {
    entry.abort = () => {
      over = true;
      wake(entry);
      made?.close('gave up');
      reject(failure(UNREACHABLE));
    };
    timer = self.timers.setTimeout(entry.abort, DIAL_MS);
  });
  expired.catch(() => undefined);
  const ctx = {
    hub: entry.hub,
    runtime: FOLLOWER,
    post: self.post,
    makePeer: self.makePeer,
    cert: () => self.cert(entry.hub),
    hello: () => ({ name: self.name, mode: 'remote', node: self.newId(), caps: [] }),
    timers: self.timers,
    now: self.now,
    url: () => entry.current,
    keep: (next) => {
      entry.current = next;
      if (entry.known) remember(self, entry);
    },
    over: () => over || entry.over,
    nap: (ms) => sleep(self.timers, ms, entry.stop),
    waiting: () => {
      if (!entry.waiters.size) throw failure(AWAY);
    },
    adopt: (link) => {
      made = link;
      entry.link = link;
    },
    accept: () => Promise.reject(failure('EACCES')),
  };
  try {
    if (entry.relink) {
      entry.relink = false;
      await self.forget(entry.hub).catch(() => undefined);
      mark(self, entry, {});
    }
    const { linked, ended } = await dial(ctx, self.newId());
    return { session: await Promise.race([linked, expired]), ended };
  } catch (error) {
    made?.close('gave up');
    if (entry.link === made) entry.link = null;
    throw error;
  } finally {
    over = true;
    entry.abort = null;
    self.timers.clearTimeout(timer);
  }
}

function linked(self, entry, session) {
  const peer = session.peer();
  entry.session = session;
  entry.seen = true;
  entry.known = true;
  if (typeof peer?.name === 'string' && peer.name) entry.name = peer.name;
  remember(self, entry);
  for (const waiter of [...entry.waiters]) waiter.resolve(session);
  self.changed();
}

function unlinked(self, entry, error) {
  mark(self, entry, { unlinked: true, ...(entry.waiters.size ? {} : { untold: true }) });
  drop(self, entry);
  settle(entry, refusal(error));
  self.changed(entry.known ? [{ ...row(entry), state: 'unlinked' }] : []);
}

function fail(self, entry, error) {
  const refused = refusal(error);
  entry.failed = sentence(refused.message);
  settle(entry, refused);
  if (!entry.known) drop(self, entry);
  self.changed();
}

async function cycle(self, entry) {
  try {
    const { session, ended } = await attempt(self, entry);
    linked(self, entry, session);
    await ended;
    entry.session = null;
    entry.link = null;
    if (!entry.over) self.changed();
    return 'linked';
  } catch (error) {
    if (entry.over) return 'stop';
    if (error.unlinked) unlinked(self, entry, error);
    else if (error.gone || error.code === 'EACCES') fail(self, entry, error);
    else return 'again';
    return 'stop';
  }
}

async function follow(self, entry) {
  entry.over = false;
  entry.failed = null;
  if (entry.running) {
    wake(entry);
    self.changed();
    return;
  }
  entry.running = true;
  self.changed();
  let attempts = 0;
  try {
    while (!entry.over && !entry.off) {
      if (!entry.known && !entry.waiters.size) return drop(self, entry);
      if (self.asleep() && !entry.waiters.size) {
        await sleep(self.timers, HIDDEN_MS, entry.stop);
        continue;
      }
      const result = await cycle(self, entry);
      if (result === 'stop' || entry.over) return;
      if (result === 'linked') attempts = 0;
      await sleep(self.timers, BACKOFF[Math.min(attempts, BACKOFF.length - 1)], entry.stop);
      attempts += 1;
    }
  } finally {
    entry.running = false;
  }
}

function reach(self, entry) {
  if (entry.session) return Promise.resolve(entry.session);
  return new Promise((resolve, reject) => {
    const done = () => {
      self.timers.clearTimeout(timer);
      entry.waiters.delete(waiter);
    };
    const waiter = {
      resolve: (session) => {
        done();
        resolve(session);
      },
      reject: (error) => {
        done();
        reject(error);
      },
    };
    const timer = self.timers.setTimeout(() => waiter.reject(failure(UNREACHABLE)), DIAL_MS);
    entry.waiters.add(waiter);
    void follow(self, entry);
  });
}

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
  document: page = globalThis.document,
}) {
  const listeners = new Set();
  const minting = new Map();
  const entries = new Map();
  let gone = [];
  let started = false;
  let hiddenAt = page?.visibilityState === 'hidden' ? now() : null;
  const self = {
    storage,
    post,
    makePeer,
    name,
    forget,
    timers,
    now,
    newId,
    entries,
    changed(fresh = []) {
      gone = fresh;
      for (const listener of [...listeners]) listener();
    },
    asleep: () => hiddenAt !== null && now() - hiddenAt >= HIDDEN_MS,
    cert(hub) {
      if (!minting.has(hub))
        minting.set(
          hub,
          Promise.resolve()
            .then(() => cert(hub))
            .finally(() => minting.delete(hub))
        );
      return minting.get(hub);
    },
  };

  page?.addEventListener?.('visibilitychange', () => {
    if (page.visibilityState === 'hidden') {
      hiddenAt ??= now();
      return;
    }
    hiddenAt = null;
    for (const entry of entries.values()) wake(entry);
  });

  async function open(join, meta) {
    const allowed = hubs(storage);
    const url = joinUrl(join, allowed);
    if (!url || !allowed.includes(hubOrigin(url))) throw failure(ELSEWHERE);
    const key = await digest(url);
    let entry = entries.get(key);
    if (!entry) {
      entry = make(self, key, url, readLeaders(storage)[key]);
      if (entry.untold) {
        mark(self, entry);
        throw refusal({ unlinked: true });
      }
      entries.set(key, entry);
    }
    if (entry.off) throw failure(DISCONNECTED);
    const session = await reach(self, entry);
    const stream = await session.open(meta).catch((error) => {
      throw refusedByLeader(error);
    });
    return { stream, release: () => undefined };
  }

  const followed = (id) => {
    const entry = entries.get(id);
    if (!entry?.known) throw new Error('This SLICC doesn’t follow that leader.');
    return entry;
  };

  return {
    open,
    start() {
      if (started) return;
      started = true;
      const allowed = hubs(storage);
      for (const [key, kept] of Object.entries(readLeaders(storage))) {
        const url = joinUrl(kept?.url, allowed);
        if (entries.has(key) || !url || !allowed.includes(hubOrigin(url))) continue;
        const entry = make(self, key, url, kept);
        if (!entry.known) continue;
        entries.set(key, entry);
        if (!entry.off) void follow(self, entry);
      }
      self.changed();
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () =>
      distinctLeaders([
        ...[...entries.values()].filter((entry) => entry.known).map(row),
        ...gone.filter((item) => !entries.has(item.id)),
      ]),
    async retry(id) {
      const entry = followed(id);
      if (entry.off)
        throw new Error('That leader is disconnected; reconnect it to follow it again.');
      entry.seen = false;
      void follow(self, entry);
    },
    async disconnect(id) {
      const entry = followed(id);
      entry.off = true;
      halt(entry, DISCONNECTED);
      remember(self, entry);
      self.changed();
    },
    async reconnect(id) {
      const entry = followed(id);
      entry.off = false;
      entry.seen = false;
      remember(self, entry);
      void follow(self, entry);
    },
    async forget(id) {
      const entry = followed(id);
      halt(entry, FORGOTTEN);
      drop(self, entry);
      mark(self, entry);
      self.changed();
    },
  };
}
