import { device, failure, offerLink } from './link.js';

export const SESSION_KEY = 'slicc-os.tray';
export const TRAY_HUB_KEY = 'slicc-os.tray-hub';
export const DEVICES_KEY = 'slicc-os.devices';
export const UNLINKED_KEY = 'slicc-os.unlinked';
export const RUNTIME = 'slicc-seven/1';
export const FOLLOWER = 'slicc-link/1';
export const ACCESS = ['view', 'control', 'terminal'];
export const PING_MS = 30_000;
export const JOIN_MS = 5_000;
export const SEAT_LINKS = 4;
export const NOT_LEADING = 'Seven isn’t connected to the tray hub yet.';
export const DENIED_KEY = 'slicc-os.revoked-seats';
export const DENY_MS = 7 * 24 * 60 * 60 * 1000;
export const SEAT_STOP = 'guest-seat-stop';
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];

export function fingerprint(sdp) {
  const found = /^a=fingerprint:sha-256 ([0-9a-f:]+)\s*$/im.exec(sdp ?? '')?.[1];
  return found ? found.replaceAll(':', '').toLowerCase() : null;
}

const WEBHOOK_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

export function webhookDelivery(message) {
  const name = message?.webhookId;
  if (typeof name !== 'string' || !WEBHOOK_NAME.test(name)) return null;
  const headers = Object.fromEntries(
    Object.entries(message.headers ?? {}).filter(
      ([key, value]) => typeof value === 'string' && !SECRET_HEADERS.has(key.toLowerCase())
    )
  );
  const { body } = message;
  const json = /json/i.test(headers['content-type'] ?? '');
  const raw =
    !json &&
    body &&
    typeof body === 'object' &&
    Object.keys(body).length === 1 &&
    typeof body.raw === 'string';
  return {
    name,
    delivery: {
      id: headers['idempotency-key'] ?? headers['x-github-delivery'] ?? null,
      headers,
      body: raw ? body.raw : JSON.stringify(body ?? null),
    },
  };
}

export function joinCommand(url) {
  return url ? `npx sliccy@next ${url} follow` : null;
}

export function followUrl(page, url) {
  return url && page ? `${page}/#follow=${encodeURIComponent(url)}` : null;
}

export function seatUrl(page, url) {
  return url && page ? `${page}/#seat=${encodeURIComponent(url)}` : null;
}

function read(storage, key, fallback) {
  try {
    return JSON.parse(storage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function trayHub(origin, fetcher) {
  const here = (url, protocol) => {
    const at = new URL(url);
    const base = new URL(origin);
    return `${protocol ?? base.protocol}//${base.host}${at.pathname}${at.search}`;
  };
  const post = async (url, body) => {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, value };
  };

  async function create() {
    const created = await post(`${origin}/tray`, {});
    if (!created.ok) throw new Error(`the tray hub answered ${created.status}`);
    const { trayId, capabilities } = created.value;
    return {
      trayId,
      controllerId: crypto.randomUUID(),
      controllerUrl: capabilities.controller.url,
      joinUrl: capabilities.join.url,
      webhookUrl: capabilities.webhook?.url ?? null,
    };
  }

  async function claim(current) {
    const attach = await post(here(current.controllerUrl), {
      controllerId: current.controllerId,
      ...(current.leaderKey ? { leaderKey: current.leaderKey } : {}),
      runtime: RUNTIME,
    });
    if (!attach.ok)
      return { gone: attach.status >= 400 && attach.status < 500, status: attach.status };
    const { role, leaderKey, websocket } = attach.value;
    if (role !== 'leader' || !websocket?.url)
      throw new Error('the tray hub did not make this page the leader');
    return {
      session: { ...current, leaderKey },
      url: here(websocket.url, new URL(origin).protocol === 'https:' ? 'wss:' : 'ws:'),
    };
  }

  const api = (current, path, body) =>
    fetcher(`${origin}/api/tray/${encodeURIComponent(current.trayId)}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${new URL(current.controllerUrl).pathname.split('/').at(-1)}`,
      },
      body: JSON.stringify(body),
    });

  async function supersede(old, joinUrl) {
    const response = await api(old, 'supersede', { joinUrl }).catch(() => null);
    return Boolean(response && response.status < 500);
  }

  async function seat(current, path, body) {
    if (!current?.trayId || !current.controllerUrl) throw new Error(NOT_LEADING);
    const response = await api(current, path, body);
    const value = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, value: value ?? {} };
  }

  async function point(current) {
    const { origin: from } = current;
    if (!from || from.pointed === current.joinUrl) return current;
    if (!(await supersede(from, current.joinUrl))) return current;
    return { ...current, origin: { ...from, pointed: current.joinUrl } };
  }

  async function lead(session, fresh = false) {
    const upgrade = !fresh && session && !('webhookUrl' in session);
    let current = !fresh && !upgrade && session ? session : await create();
    if (upgrade)
      current.origin = {
        trayId: session.trayId,
        controllerUrl: session.controllerUrl,
        pointed: null,
      };
    current = await point(current);
    let claimed = await claim(current);
    if (claimed.gone && !fresh) {
      current = await point({ ...(await create()), origin: current.origin });
      claimed = await claim(current);
    }
    if (!claimed.session) throw new Error(`the tray hub answered ${claimed.status}`);
    return claimed;
  }

  return { lead, seat };
}

const refusal = (send) => (message, code, text) =>
  send({
    type: 'bootstrap.failed',
    controllerId: message.controllerId,
    bootstrapId: message.bootstrapId,
    code,
    message: text,
    retryable: false,
    retryAfterMs: null,
  });

const relay = (send, controllerId, bootstrapId) => (out) => {
  if (out.t === 'offer') {
    send({
      type: 'bootstrap.offer',
      controllerId,
      bootstrapId,
      offer: { type: 'offer', sdp: out.sdp },
    });
  } else if (out.t === 'candidate' && out.candidate) {
    send({
      type: 'bootstrap.ice_candidate',
      controllerId,
      bootstrapId,
      candidate: out.candidate,
    });
  }
};

function followers({ links, send, devices, unlinked, pinned }) {
  const refuse = refusal(send);

  function join(message) {
    const { controllerId, bootstrapId } = message;
    if (message.runtime !== FOLLOWER && message.runtime !== RUNTIME)
      return refuse(message, 'UNSUPPORTED_RUNTIME', 'seven links only slicc CLIs and sevens');
    if ((message.trust ?? 'full') !== 'full')
      return refuse(message, 'UNTRUSTED', 'a link needs a fully trusted follower');
    const link = links.start({
      key: controllerId,
      mode: 'remote',
      kind: message.runtime === RUNTIME ? 'seven' : 'cli',
      iceServers: message.iceServers ?? [],
      send: relay(send, controllerId, bootstrapId),
    });
    link.bootstrapId = bootstrapId;
  }

  function answer(message) {
    const link = links.links.get(message.controllerId);
    if (link?.bootstrapId !== message.bootstrapId) return;
    const id = fingerprint(message.answer?.sdp);
    if (!id || unlinked.has(id)) {
      refuse(
        message,
        id ? 'UNLINKED' : 'NO_FINGERPRINT',
        id
          ? 'this device was unlinked; run the join command again'
          : 'the answer has no SHA-256 fingerprint'
      );
      links.drop(message.controllerId, id ? 'unlinked' : 'no fingerprint');
      return;
    }
    link.fingerprint = id;
    links.identify(message.controllerId, id, devices()[id]?.address);
    pinned();
    void link.offer.receive({ t: 'answer', sdp: message.answer.sdp });
  }

  function candidate(message) {
    const link = links.links.get(message.controllerId);
    if (link?.bootstrapId !== message.bootstrapId) return;
    void link.offer.receive({ t: 'candidate', candidate: message.candidate });
  }

  return { join, answer, candidate };
}

export function seatDenials(storage, now = Date.now) {
  const load = () => {
    const kept = read(storage, DENIED_KEY, {});
    const at = now();
    return Object.fromEntries(
      Object.entries(kept && typeof kept === 'object' ? kept : {}).filter(
        ([, until]) => Number.isFinite(until) && until > at
      )
    );
  };
  return {
    has: (id) => Object.hasOwn(load(), id),
    add(id, until) {
      const all = load();
      const end = Number.isFinite(until) && until > now() ? until : now() + DENY_MS;
      all[id] = Math.max(all[id] ?? 0, end);
      storage.setItem(DENIED_KEY, JSON.stringify(all));
    },
  };
}

function guests({ send, makePeer, serve, timers, denials, expiries }) {
  const refuse = refusal(send);
  const live = new Map();
  const close = (item, reason) => {
    if (live.get(item.controllerId) === item) live.delete(item.controllerId);
    item.offer.session.close(reason);
  };

  function accept(item, meta) {
    if (meta.kind !== 'pi') return Promise.reject(failure('EOPNOTSUPP'));
    if (item.open) return Promise.reject(failure('EBUSY'));
    item.open = true;
    return {
      handle: async (stream) => {
        try {
          await serve(item.seat, stream);
        } catch (error) {
          stream.reset(`${error.code ?? 'EIO'}: ${error.message}`);
        } finally {
          item.open = false;
        }
      },
    };
  }

  function join(message) {
    const { controllerId, bootstrapId, biscotto } = message;
    if (message.runtime !== RUNTIME)
      return refuse(message, 'UNSUPPORTED_RUNTIME', 'a guest joins from a seven page');
    const id = typeof biscotto?.id === 'string' ? biscotto.id : '';
    const label = typeof biscotto?.label === 'string' ? biscotto.label : '';
    if (!id || !label) return refuse(message, 'UNTRUSTED', 'a guest link needs its seat');
    if (denials.has(id)) return refuse(message, 'UNTRUSTED', 'this guest seat was revoked');
    const expires = Date.parse(biscotto.expiresAt ?? '');
    if (Number.isFinite(expires)) expiries.set(id, expires);
    const before = live.get(controllerId);
    if (before) close(before, 'replaced');
    const same = [...live.values()].filter((item) => item.seat.id === id);
    for (const old of same.slice(0, Math.max(0, same.length - SEAT_LINKS + 1)))
      close(old, 'replaced');
    const item = { controllerId, bootstrapId, seat: { id, label }, open: false };
    item.offer = offerLink({
      pc: makePeer({ iceServers: message.iceServers ?? [] }),
      send: relay(send, controllerId, bootstrapId),
      hello: () => ({
        name: 'SLICC',
        mode: 'remote',
        caps: ['pi'],
        permissions: { view: true, control: false, terminal: false },
      }),
      accept: (meta) => accept(item, meta),
      timers,
      onClose: () => {
        if (live.get(controllerId) === item) live.delete(controllerId);
      },
    });
    live.set(controllerId, item);
  }

  const mine = (message) => {
    const item = live.get(message.controllerId);
    return item?.bootstrapId === message.bootstrapId ? item : null;
  };

  return {
    join,
    has: (controllerId) => live.has(controllerId),
    answer(message) {
      if (message.answer?.sdp)
        void mine(message)?.offer.receive({ t: 'answer', sdp: message.answer.sdp });
    },
    candidate(message) {
      void mine(message)?.offer.receive({ t: 'candidate', candidate: message.candidate });
    },
    revoked(id) {
      denials.add(id, expiries.get(id));
      for (const item of [...live.values()]) if (item.seat.id === id) close(item, 'revoked');
    },
  };
}

function remember(links, devices, save) {
  let dirty = false;
  for (const link of links.links.values()) {
    if (link.mode !== 'remote' || !link.peer || !link.fingerprint) continue;
    const known = devices[link.id];
    const capable = Array.isArray(link.peer.caps) && link.peer.caps.length > 0;
    if (known && !capable) continue;
    const { name, offers, policy, exit } = device(link);
    const next = {
      name,
      ...(link.kind === 'seven' ? { kind: 'seven' } : {}),
      label: link.label,
      address: link.address,
      offers,
      policy,
      exit,
      ...Object.fromEntries(ACCESS.filter((key) => known?.[key]).map((key) => [key, true])),
    };
    if (JSON.stringify(known) !== JSON.stringify(next)) {
      devices[link.id] = next;
      dirty = true;
    }
  }
  if (dirty) save();
}

function awayDevices(devices, links) {
  const live = new Set(
    [...links.links.values()].filter((link) => link.peer).map((link) => link.id)
  );
  return Object.entries(devices)
    .filter(([id]) => !live.has(id))
    .map(([id, known]) => ({
      id,
      name: known.name,
      host: known.label ? `${known.label}.slicc.internal` : '',
      address: known.kind === 'seven' ? '' : known.address,
      mode: 'remote',
      offers: known.offers ?? [],
      ...(known.policy ? { policy: known.policy } : {}),
      exit: Boolean(known.exit),
      ...(known.kind === 'seven'
        ? { kind: 'seven', access: granted(known), ...(known.view ? {} : { asking: true }) }
        : {
            kind: 'cli',
            access: { control: known.control === true },
            control: { allowed: known.control === true },
          }),
      state: 'offline',
    }));
}

export function permit(known, name, allowed) {
  if (!known) throw new Error('That device isn’t linked.');
  if (!ACCESS.includes(name)) throw new Error(`There is no ${name} access.`);
  const wanted = { ...granted(known), [name]: Boolean(allowed) };
  if (name !== 'view' && allowed) wanted.view = true;
  if (name === 'view' && !allowed) Object.assign(wanted, { control: false, terminal: false });
  for (const key of ACCESS) {
    if (wanted[key]) known[key] = true;
    else delete known[key];
  }
  return granted(known);
}

function described(state, error, session, page) {
  const joinUrl = state === 'ready' ? session.joinUrl : null;
  return {
    state,
    error,
    joinUrl,
    joinCommand: joinCommand(joinUrl),
    webhookUrl: state === 'ready' ? (session.webhookUrl ?? null) : null,
    followUrl: followUrl(page, joinUrl),
  };
}

export function granted(known) {
  return Object.fromEntries(ACCESS.map((key) => [key, known?.[key] === true]));
}

async function unlinkAll(links, id, notify) {
  const mine = [...links.links.values()].filter((item) => item.id === id);
  await Promise.all(
    mine.filter((item) => item.peer).map((item) => notify(item, { kind: 'unlink' }))
  );
  for (const item of mine) links.drop(item.key, 'unlinked');
}

function joins(follower, seats) {
  const pick = (message) => (seats?.has(message.controllerId) ? seats : follower);
  return {
    'follower.join_requested': (message) =>
      seats && message.trust === 'biscotto' ? seats.join(message) : follower.join(message),
    'bootstrap.answer': (message) => pick(message).answer(message),
    'bootstrap.ice_candidate': (message) => pick(message).candidate(message),
    'biscotto.revoked': (message) => seats?.revoked(message.biscottoId),
  };
}

const failed = (answered) =>
  new Error(answered.value.error ?? `the tray hub answered ${answered.status}`);

const unrevoked = (reason) =>
  new Error(
    `Seven refuses this guest from now on, but the tray hub didn’t revoke the link: ${reason}`
  );

function seatHub({ hub, storage, page, now, seats, denials, expiries }) {
  return {
    async mint({ label, expiresAt, agentId }) {
      const ttl = expiresAt == null ? {} : { ttlMs: Math.max(1, Math.round(expiresAt - now())) };
      const minted = await hub.seat(read(storage, SESSION_KEY, null), 'biscotto', {
        label,
        unitJid: agentId,
        ...ttl,
      });
      const url = typeof minted.value.url === 'string' ? minted.value.url : null;
      if (!minted.ok || typeof minted.value.id !== 'string' || !url) throw failed(minted);
      if (Number.isFinite(expiresAt)) expiries.set(minted.value.id, expiresAt);
      return { id: minted.value.id, url: seatUrl(page, url) };
    },
    async revoke(id) {
      denials.add(id, expiries.get(id));
      seats?.revoked(id);
      const stopped = await hub
        .seat(read(storage, SESSION_KEY, null), 'biscotto/stop', { id })
        .catch((error) => Promise.reject(unrevoked(error.message)));
      if (!stopped.ok && stopped.status !== 404) throw unrevoked(failed(stopped).message);
    },
  };
}

const notifier =
  (timers) =>
  async (link, meta, cap = 'join') => {
    if (!link.offer.session.caps().includes(cap)) return false;
    const stream = await Promise.race([
      link.offer.session.open(meta, { shared: true }),
      new Promise((resolve) => timers.setTimeout(resolve, JOIN_MS, null)),
    ]).catch(() => null);
    stream?.closeWrite();
    return Boolean(stream);
  };

function guestSide({ storage, now, send, makePeer, onGuest, timers, hub, page }) {
  const denials = seatDenials(storage, now);
  const expiries = new Map();
  const seats = onGuest
    ? guests({ send, makePeer, serve: onGuest, timers, denials, expiries })
    : null;
  return { seats, guestHub: seatHub({ hub, storage, page, now, seats, denials, expiries }) };
}

export function seatNotices(guests, notices) {
  const revoke = async (id) => {
    const notice = `${SEAT_STOP}:${id}`;
    try {
      await guests.revoke(id);
      notices.remove(notice);
    } catch (error) {
      notices.show(
        {
          id: notice,
          tone: 'warning',
          title: 'A revoked guest’s link is still on the tray hub',
          body: error.message,
          actions: [{ id: 'retry', label: 'Try again' }],
        },
        () => revoke(id).catch(() => undefined)
      );
      throw error;
    }
  };
  return { mint: (draft) => guests.mint(draft), revoke };
}

export function createTray({
  links,
  origin = location.origin,
  page = origin,
  fetch: fetcher = (...args) => fetch(...args),
  WebSocket: Socket = WebSocket,
  storage = localStorage,
  timers = globalThis,
  onWebhook = null,
  onGuest = null,
  makePeer = (config) => new RTCPeerConnection(config),
  now = Date.now,
}) {
  const listeners = new Set();
  let session = read(storage, SESSION_KEY, null);
  const devices = read(storage, DEVICES_KEY, {});
  const unlinked = new Set(read(storage, UNLINKED_KEY, []));
  let socket = null;
  let ping = null;
  let retry = null;
  let attempts = 0;
  let stopped = true;
  let state = 'idle';
  let error = null;
  const hub = trayHub(origin, fetcher);
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const save = () => {
    storage.setItem(DEVICES_KEY, JSON.stringify(devices));
    storage.setItem(UNLINKED_KEY, JSON.stringify([...unlinked]));
  };
  const send = (message) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
  };

  const follower = followers({
    links,
    send,
    devices: () => devices,
    unlinked,
    pinned: () => remember(links, devices, save),
  });
  const { seats, guestHub } = guestSide({
    storage,
    now,
    send,
    makePeer,
    onGuest,
    timers,
    hub,
    page,
  });
  const handlers = {
    'leader.connected': () => {
      state = 'ready';
      error = null;
      attempts = 0;
      changed();
    },
    ...joins(follower, seats),
    'webhook.event': (message) => {
      const found = webhookDelivery(message);
      if (!found || !onWebhook) return;
      Promise.resolve()
        .then(() => onWebhook(found.name, found.delivery))
        .catch((failed) => console.warn(`webhook ${found.name}: ${failed.message}`));
    },
  };

  function open(claimed) {
    const next = new Socket(claimed.url);
    next.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (next === socket) handlers[message.type]?.(message);
    });
    next.addEventListener('close', () => {
      if (next !== socket) return;
      socket = null;
      timers.clearInterval(ping);
      state = 'reconnecting';
      changed();
      schedule();
    });
    return next;
  }

  function adopt(claimed) {
    const old = socket;
    session = claimed.session;
    storage.setItem(SESSION_KEY, JSON.stringify(session));
    socket = open(claimed);
    old?.close();
    timers.clearInterval(ping);
    ping = timers.setInterval(() => send({ type: 'ping' }), PING_MS);
    changed();
  }

  async function connect() {
    retry = null;
    try {
      const claimed = await hub.lead(session);
      if (stopped) return;
      adopt(claimed);
    } catch (failure) {
      if (stopped) return;
      state = 'failed';
      error = failure.message;
      changed();
      schedule();
    }
  }

  function schedule() {
    timers.clearTimeout(retry);
    retry = timers.setTimeout(connect, BACKOFF[Math.min(attempts, BACKOFF.length - 1)]);
    attempts += 1;
  }

  const notify = notifier(timers);

  async function setAccess(id, name, allowed) {
    const now = permit(devices[id], name, allowed);
    save();
    changed();
    const live = [...links.links.values()].filter((link) => link.id === id && link.peer);
    await Promise.all(
      live.map((link) => notify(link, { kind: 'permissions', ...now }, 'permissions'))
    );
  }

  links.on(() => remember(links, devices, save));

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (!stopped) return;
      stopped = false;
      state = 'connecting';
      changed();
      void connect();
    },
    stop() {
      stopped = true;
      timers.clearTimeout(retry);
      timers.clearInterval(ping);
      const old = socket;
      socket = null;
      old?.close();
      state = 'idle';
      changed();
    },
    guests: guestHub,
    status: () => described(state, error, session, page),
    away: () => awayDevices(devices, links),
    known: (id) => id in devices,
    controlAllowed: (id) => devices[id]?.control === true,
    access: (id) => granted(devices[id]),
    setControl: (id, allowed) => setAccess(id, 'control', allowed),
    setAccess,
    async forget(id) {
      delete devices[id];
      unlinked.add(id);
      save();
      await unlinkAll(links, id, notify);
      changed();
    },
    async rotate() {
      const fresh = await hub.lead(session, true);
      const told = await Promise.all(
        [...links.links.values()]
          .filter((link) => link.mode === 'remote')
          .map((link) => notify(link, { kind: 'join', url: fresh.session.joinUrl }))
      );
      adopt(fresh);
      return told.filter(Boolean).length;
    },
  };
}

const CONNECTION = {
  idle: 'offline',
  connecting: 'connecting',
  ready: 'live',
  reconnecting: 'reconnecting',
  failed: 'error',
};

export const displayName = (name) => String(name ?? '').replace(/^slicc\b/i, 'SLICC');

export function trayPort(network, { name }) {
  const status = () => {
    const links = network.status().links ?? {};
    const tray = Boolean(links.sync) && links.sync !== 'idle';
    return {
      name,
      kind: 'hosted',
      connection: CONNECTION[links.sync] ?? 'offline',
      role: tray ? 'leader' : 'none',
      followers: (tray ? (links.devices ?? []) : [])
        .filter((item) => item.mode === 'remote' && item.state === 'connected')
        .map((item) => ({
          id: item.id,
          name: displayName(item.name),
          device: item.kind === 'seven' ? 'browser' : 'cli',
          since: 0,
        })),
      joinUrl: links.joinUrl ?? '',
    };
  };
  return {
    on(type, listener) {
      if (type !== 'status') return () => undefined;
      return network.on('network', () => listener(status()));
    },
    status,
    reconnect: () => void network.retryLinks?.(),
    disconnect: () => void network.stopLinks?.(),
  };
}
