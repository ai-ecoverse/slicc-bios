import { device } from './link.js';

export const SESSION_KEY = 'slicc-os.tray';
export const TRAY_HUB_KEY = 'slicc-os.tray-hub';
export const DEVICES_KEY = 'slicc-os.devices';
export const UNLINKED_KEY = 'slicc-os.unlinked';
export const RUNTIME = 'slicc-seven/1';
export const FOLLOWER = 'slicc-link/1';
export const PING_MS = 30_000;
export const JOIN_MS = 5_000;
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
  const raw =
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

  async function supersede(old, joinUrl) {
    const token = new URL(old.controllerUrl).pathname.split('/').at(-1);
    const response = await fetcher(
      `${origin}/api/tray/${encodeURIComponent(old.trayId)}/supersede`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ joinUrl }),
      }
    ).catch(() => null);
    return Boolean(response && response.status < 500);
  }

  async function lead(session, fresh = false) {
    const upgrade = !fresh && session && !('webhookUrl' in session);
    let current = !fresh && !upgrade && session ? session : await create();
    if (upgrade)
      current.superseding = { trayId: session.trayId, controllerUrl: session.controllerUrl };
    if (current.superseding && (await supersede(current.superseding, current.joinUrl))) {
      const { superseding: _, ...done } = current;
      current = done;
    }
    let claimed = await claim(current);
    if (claimed.gone && !fresh) {
      current = await create();
      claimed = await claim(current);
    }
    if (!claimed.session) throw new Error(`the tray hub answered ${claimed.status}`);
    return claimed;
  }

  return { lead };
}

function followers({ links, send, devices, unlinked, pinned }) {
  const refuse = (message, code, text) =>
    send({
      type: 'bootstrap.failed',
      controllerId: message.controllerId,
      bootstrapId: message.bootstrapId,
      code,
      message: text,
      retryable: false,
      retryAfterMs: null,
    });

  function join(message) {
    const { controllerId, bootstrapId } = message;
    if (message.runtime !== FOLLOWER)
      return refuse(message, 'UNSUPPORTED_RUNTIME', 'seven links only slicc CLI followers');
    if ((message.trust ?? 'full') !== 'full')
      return refuse(message, 'UNTRUSTED', 'a link needs a fully trusted follower');
    const link = links.start({
      key: controllerId,
      mode: 'remote',
      iceServers: message.iceServers ?? [],
      send: (out) => {
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
      },
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
      label: link.label,
      address: link.address,
      offers,
      policy,
      exit,
      ...(known?.control ? { control: true } : {}),
    };
    if (JSON.stringify(known) !== JSON.stringify(next)) {
      devices[link.id] = next;
      dirty = true;
    }
  }
  if (dirty) save();
}

function awayDevices(devices, links) {
  const live = new Set([...links.links.values()].map((link) => link.id));
  return Object.entries(devices)
    .filter(([id]) => !live.has(id))
    .map(([id, known]) => ({
      id,
      name: known.name,
      host: known.label ? `${known.label}.slicc.internal` : '',
      address: known.address,
      mode: 'remote',
      offers: known.offers ?? [],
      ...(known.policy ? { policy: known.policy } : {}),
      exit: Boolean(known.exit),
      control: { allowed: known.control === true },
      state: 'offline',
    }));
}

export function createTray({
  links,
  origin = location.origin,
  fetch: fetcher = (...args) => fetch(...args),
  WebSocket: Socket = WebSocket,
  storage = localStorage,
  timers = globalThis,
  onWebhook = null,
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
  const handlers = {
    'leader.connected': () => {
      state = 'ready';
      error = null;
      attempts = 0;
      changed();
    },
    'follower.join_requested': follower.join,
    'bootstrap.answer': follower.answer,
    'bootstrap.ice_candidate': follower.candidate,
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

  const notify = async (link, meta) => {
    if (!link.offer.session.caps().includes('join')) return false;
    const stream = await Promise.race([
      link.offer.session.open(meta, { shared: true }),
      new Promise((resolve) => timers.setTimeout(resolve, JOIN_MS, null)),
    ]).catch(() => null);
    stream?.closeWrite();
    return Boolean(stream);
  };

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
    status() {
      const joinUrl = state === 'ready' ? session.joinUrl : null;
      const webhookUrl = state === 'ready' ? (session.webhookUrl ?? null) : null;
      return { state, error, joinUrl, joinCommand: joinCommand(joinUrl), webhookUrl };
    },
    away: () => awayDevices(devices, links),
    known: (id) => id in devices,
    controlAllowed: (id) => devices[id]?.control === true,
    setControl(id, allowed) {
      const known = devices[id];
      if (!known) throw new Error('That device isn’t linked.');
      if (allowed) known.control = true;
      else delete known.control;
      save();
      changed();
    },
    async forget(id) {
      delete devices[id];
      unlinked.add(id);
      save();
      const link = [...links.links.values()].find((item) => item.id === id);
      if (link) {
        await notify(link, { kind: 'unlink' });
        links.drop(link.key, 'unlinked');
      }
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
