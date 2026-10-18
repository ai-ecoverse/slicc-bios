import { answerLink, failure } from './link.js';
import { fingerprint, RUNTIME, TRAY_HUB_KEY } from './tray.js';

export const FOLLOW_KEY = 'slicc-os.follow';
export const HUB = 'https://www.sliccy.ai';
export const CERTS = 'slicc-follow';
export const POLL_MS = 1_000;
export const OFFER_MS = 30_000;
export const MAX_HOPS = 5;
export const CERT_DAYS = 365;
const DAY = 24 * 60 * 60 * 1000;
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];
const GONE = new Set(['INVALID_JOIN_CAPABILITY', 'TRAY_EXPIRED']);

export function deviceName(scope = globalThis.navigator) {
  const platform = scope?.userAgentData?.platform || scope?.platform || '';
  return platform ? `SLICC on ${platform}` : 'SLICC';
}

export function hubs(storage) {
  return [HUB, storage.getItem(TRAY_HUB_KEY)].filter(Boolean);
}

export function joinUrl(text, allowed = null) {
  try {
    const url = new URL(String(text ?? '').trim());
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    const token = /^\/join\/[^/]+$/.test(url.pathname);
    if (!secure || !token || url.username || url.password || url.hash) return null;
    if (allowed && !loopback && !allowed.includes(url.origin)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function hubOrigin(url) {
  return new URL(url).origin;
}

function read(storage) {
  try {
    const kept = JSON.parse(storage.getItem(FOLLOW_KEY));
    return joinUrl(kept?.url, hubs(storage)) && kept.hub === hubOrigin(kept.url)
      ? { hub: kept.hub, url: kept.url }
      : null;
  } catch {
    return null;
  }
}

export function keepFollow(kept, storage = localStorage) {
  storage.setItem(FOLLOW_KEY, JSON.stringify({ hub: kept.hub, url: kept.url }));
}

let taken = null;

export function takeFollow({
  location: at = location,
  history: past = history,
  storage = localStorage,
} = {}) {
  const params = new URLSearchParams(at.hash.slice(1));
  if (params.has('follow')) {
    const url = joinUrl(params.get('follow'), hubs(storage));
    params.delete('follow');
    const rest = params.toString();
    past.replaceState(past.state, '', `${at.pathname}${at.search}${rest ? `#${rest}` : ''}`);
    taken = url ? { hub: hubOrigin(url), url, fresh: read(storage)?.url !== url } : taken;
  }
  return taken ?? read(storage);
}

function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

async function certificates(mode, act, idb) {
  const opening = idb.open(CERTS, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('certificates');
  const db = await request(opening);
  try {
    return await request(act(db.transaction('certificates', mode).objectStore('certificates')));
  } finally {
    db.close();
  }
}

export async function certificate(
  hub,
  {
    idb = indexedDB,
    generate = (options) => RTCPeerConnection.generateCertificate(options),
    now = Date.now,
  } = {}
) {
  const kept = await certificates('readonly', (store) => store.get(hub), idb);
  if (kept && kept.expires > now() + DAY) return kept;
  const made = await generate({
    name: 'ECDSA',
    namedCurve: 'P-256',
    expires: CERT_DAYS * DAY,
  });
  await certificates('readwrite', (store) => store.put(made, hub), idb);
  return made;
}

export function dropCertificate(hub, { idb = indexedDB } = {}) {
  return certificates('readwrite', (store) => store.delete(hub), idb);
}

const refused = (code, message, extra = {}) =>
  Object.assign(failure(`${code}: ${message}`), { gone: GONE.has(code), ...extra });

export function successor(response, value) {
  const result = value?.result;
  const named = result?.code === 'TRAY_SUPERSEDED' || result?.action === 'redirect';
  const link = /<([^>]+)>\s*;\s*rel="?successor-version"?/i.exec(
    response.headers?.get?.('link') ?? ''
  )?.[1];
  return (
    (named ? joinUrl(result.joinUrl ?? result.url) : null) ??
    joinUrl(link) ??
    joinUrl(response.headers?.get?.('x-tray-location'))
  );
}

export function hubClient({ origin, fetch: fetcher }) {
  const target = (url) => {
    const at = new URL(url);
    return origin ? `${origin}${at.pathname}${at.search}` : at.href;
  };
  return async (url, body) => {
    const response = await fetcher(target(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => null);
    const moved = successor(response, value);
    if (moved) return { moved };
    if (!value) throw failure(`EPROTO: the tray hub answered ${response.status} without JSON`);
    if (value.role !== 'follower') {
      const code = value.code ?? `HTTP_${response.status}`;
      throw refused(code, value.error ?? 'the tray hub refused');
    }
    return { value };
  };
}

const clamp = (ms) => Math.min(Math.max(Number.isFinite(ms) ? ms : 1_000, 50), 30_000);

export function sleep(timers, ms, stop) {
  return new Promise((resolve) => {
    const wake = () => {
      timers.clearTimeout(timer);
      stop.delete(wake);
      resolve();
    };
    const timer = timers.setTimeout(wake, ms);
    stop.add(wake);
  });
}

async function attach(ctx, controllerId) {
  for (let hops = 0; ; ) {
    const answer = await ctx.post(ctx.url(), { controllerId, runtime: ctx.runtime ?? RUNTIME });
    if (answer.moved) {
      if (hubOrigin(answer.moved) !== ctx.hub)
        throw failure('EACCES: the tray moved to another hub');
      hops += 1;
      if (hops > MAX_HOPS) throw failure('ELOOP: the tray moved too many times');
      ctx.keep(answer.moved);
      continue;
    }
    const { result } = answer.value;
    if (result?.action === 'signal' && result.bootstrap?.bootstrapId) return answer.value;
    if (result?.action === 'fail') throw refused(result.code, result.error ?? 'attach failed');
    if (result?.action !== 'wait') throw failure('EPROTO: the tray hub answered no result');
    ctx.waiting();
    await ctx.nap(clamp(result.retryAfterMs));
    if (ctx.over()) throw failure('ECANCELED: left');
  }
}

function relay(link, events) {
  let offered = false;
  for (const event of events) {
    if (event.type === 'bootstrap.offer' && event.offer?.sdp) {
      offered = true;
      void link.receive({ t: 'offer', sdp: event.offer.sdp }).catch(() => undefined);
    } else if (event.type === 'bootstrap.ice_candidate') {
      void link.receive({ t: 'candidate', candidate: event.candidate }).catch(() => undefined);
    }
  }
  return offered;
}

async function poll(ctx, link, ids, waits) {
  const started = ctx.now();
  let cursor = 0;
  let offered = false;
  while (!waits.up() && !link.closed() && !ctx.over()) {
    const { value, moved } = await ctx.post(ctx.url(), { action: 'poll', ...ids, cursor });
    if (moved) {
      if (hubOrigin(moved) === ctx.hub) ctx.keep(moved);
      throw failure('ESTALE: the tray moved to a new join URL');
    }
    const events = value.events ?? [];
    for (const event of events) cursor = Math.max(cursor, event.sequence ?? 0);
    cursor = Math.max(cursor, value.bootstrap?.cursor ?? 0);
    offered = relay(link, events) || offered;
    const failed = value.bootstrap?.state === 'failed' ? (value.bootstrap.failure ?? {}) : null;
    if (failed) {
      const code = failed.code ?? 'EPROTO';
      throw refused(code, failed.message ?? 'the bootstrap failed', {
        unlinked: code === 'UNLINKED',
        gone: GONE.has(code) || failed.retryable === false,
      });
    }
    if (!offered && ctx.now() - started > OFFER_MS) {
      throw failure('ETIMEDOUT: no offer from the owner');
    }
    await Promise.race([ctx.nap(POLL_MS), waits.linked, waits.ended]);
  }
}

async function signal(ctx, controllerId, attached) {
  const ids = { controllerId, bootstrapId: attached.result.bootstrap.bootstrapId };
  const pc = ctx.makePeer({
    iceServers: attached.iceServers ?? [],
    certificates: [await ctx.cert()],
  });
  let closed;
  const ended = new Promise((resolve) => {
    closed = resolve;
  });
  const link = answerLink({
    pc,
    send: (message) =>
      ctx.post(
        ctx.url(),
        message.t === 'answer'
          ? { action: 'answer', ...ids, answer: { type: 'answer', sdp: message.sdp } }
          : { action: 'ice-candidate', ...ids, candidate: message.candidate }
      ),
    hello: ctx.hello,
    timers: ctx.timers,
    accept: ctx.accept,
    onClose: closed,
  });
  ctx.adopt(link);
  const linked = link.linked.then((made) => made.ready.then(() => made));
  let up = false;
  const settled = linked.then(
    () => {
      up = true;
    },
    () => undefined
  );
  try {
    await poll(ctx, link, ids, { up: () => up, linked: settled, ended });
  } catch (failed) {
    link.close(failed.code ?? 'the bootstrap failed');
    throw failed;
  }
  return { linked, ended };
}

export async function dial(ctx, controllerId) {
  return signal(ctx, controllerId, await attach(ctx, controllerId));
}

const NONE = { view: false, control: false, terminal: false };

export function createFollow({
  kept,
  storage = localStorage,
  post,
  makePeer,
  cert = () => certificate(kept.hub),
  forget = () => dropCertificate(kept.hub),
  hello,
  accept = () => Promise.reject(failure('EOPNOTSUPP')),
  timers = globalThis,
  now = Date.now,
  newId = () => crypto.randomUUID(),
}) {
  const listeners = new Set();
  const stop = new Set();
  let url = kept.url;
  let state = 'connecting';
  let error = null;
  let owner = null;
  let access = NONE;
  let session = null;
  let link = null;
  let attempts = 0;
  let over = false;

  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const set = (next, why = null) => {
    state = next;
    error = why;
    changed();
  };
  const keep = (next) => {
    url = next;
    storage.setItem(FOLLOW_KEY, JSON.stringify({ hub: kept.hub, url }));
  };
  const halt = () => {
    over = true;
    for (const wake of [...stop]) wake();
    link?.close('left');
  };

  async function unlinked() {
    halt();
    storage.removeItem(FOLLOW_KEY);
    await forget().catch(() => undefined);
    set('unlinked');
  }

  const owned = {
    permissions(meta) {
      access = Object.fromEntries(Object.keys(NONE).map((key) => [key, meta[key] === true]));
      changed();
      return null;
    },
    join(meta) {
      const next = joinUrl(meta.url);
      if (!next || hubOrigin(next) !== kept.hub) return Promise.reject(failure('EACCES'));
      keep(next);
      return null;
    },
    unlink() {
      timers.setTimeout(() => void unlinked(), 0);
      return null;
    },
  };

  const ctx = {
    hub: kept.hub,
    post,
    makePeer,
    cert,
    hello,
    timers,
    now,
    url: () => url,
    keep,
    over: () => over,
    nap: (ms) => sleep(timers, ms, stop),
    waiting: () => {
      if (owner) set('reconnecting');
    },
    adopt: (made) => {
      link = made;
    },
    accept: (meta) => (Object.hasOwn(owned, meta.kind) ? owned[meta.kind](meta) : accept(meta)),
  };

  async function follow(made, ended) {
    const named = String(made.peer().name ?? 'SLICC');
    const clash = named === hello().name;
    owner = clash ? `${named} · ${(fingerprint(link.remote()) ?? '').slice(0, 4)}` : named;
    session = made;
    attempts = 0;
    owned.permissions(made.peer().permissions ?? {});
    set('connected');
    await ended;
    session = null;
  }

  async function fail(why) {
    if (why.unlinked) await unlinked();
    else if (why.gone) {
      halt();
      set(
        'failed',
        `Couldn’t reach ${owner ?? new URL(kept.hub).host}. It may be closed or offline.`
      );
    } else error = why.message;
  }

  async function run() {
    while (!over) {
      try {
        const controllerId = newId();
        const { linked, ended } = await dial(ctx, controllerId);
        if (!over) await follow(await linked, ended);
      } catch (why) {
        if (!over) await fail(why);
      }
      if (over) return;
      set(owner ? 'reconnecting' : 'connecting', error);
      await ctx.nap(BACKOFF[Math.min(attempts, BACKOFF.length - 1)]);
      attempts += 1;
    }
  }

  return {
    start: () => void run(),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => ({
      owner: owner ?? new URL(kept.hub).host,
      link: state,
      access,
      name: hello().name,
      ...(error ? { error } : {}),
    }),
    async retry() {
      if (state !== 'failed') return;
      over = false;
      set('connecting');
      void run();
    },
    session: () => session,
    async open(meta) {
      if (!session) throw failure('ENOTCONN: not following anyone right now');
      return session.open(meta);
    },
    async leave() {
      halt();
      storage.removeItem(FOLLOW_KEY);
    },
  };
}
