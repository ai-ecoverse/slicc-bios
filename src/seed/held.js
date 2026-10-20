import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const CHANNEL = 'slicc-held';
export const KEY = 'slicc-os.held-targets';
export const MARK = 'slicc-sign-in-';
export const KEEP = 32;
export const WAIT = 5000;
const EVERY = 200;

const held = new Set();

function stored(storage) {
  try {
    const list = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function isHeld(targetId, storage = globalThis.localStorage) {
  if (typeof targetId !== 'string') return false;
  return held.has(targetId) || stored(storage).includes(targetId);
}

export function hold(targetId, storage = globalThis.localStorage) {
  if (held.has(targetId)) return;
  held.add(targetId);
  const list = [...stored(storage).filter((id) => id !== targetId), targetId].slice(-KEEP);
  try {
    storage?.setItem(KEY, JSON.stringify(list));
  } catch {}
}

export function markerUrl(marker) {
  return `about:blank#${MARK}${marker}`;
}

function ask(connection, method, params = {}) {
  return new Promise((resolve) => {
    const id = 1;
    connection.onmessage = (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id === id) resolve(message.result ?? null);
    };
    connection.onclose = () => resolve(null);
    connection.send(JSON.stringify({ id, method, params }));
  });
}

async function find(open, url, deadline, now, sleep) {
  let connection;
  try {
    connection = await open();
  } catch {
    return null;
  }
  try {
    for (;;) {
      const result = await ask(connection, 'Target.getTargets');
      const found = result?.targetInfos?.find((info) => info.type === 'page' && info.url === url);
      if (found) return found.targetId;
      if (!result || now() >= deadline) return null;
      await sleep(EVERY);
    }
  } finally {
    connection.close();
  }
}

export function watchSignIns({
  hosts,
  storage = globalThis.localStorage,
  listen = (name) => new BroadcastChannel(name),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  wait = WAIT,
}) {
  const channel = listen(CHANNEL);
  channel.onmessage = async ({ data }) => {
    if (data?.type !== 'hold' || typeof data.marker !== 'string' || !data.marker) return;
    const url = markerUrl(data.marker);
    const deadline = now() + wait;
    const opens = Object.values(hosts() ?? {}).filter((open) => typeof open === 'function');
    const found = await Promise.all(opens.map((open) => find(open, url, deadline, now, sleep)));
    const ids = found.filter(Boolean);
    for (const id of ids) hold(id, storage);
    channel.postMessage({ type: ids.length ? 'held' : 'none', marker: data.marker });
  };
  return () => channel.close();
}

export function askHold(
  marker,
  { listen = (name) => new BroadcastChannel(name), wait = WAIT + 1000, signal } = {}
) {
  return new Promise((resolve) => {
    const channel = listen(CHANNEL);
    const finish = (answer) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      channel.close();
      resolve(answer);
    };
    const stop = () => finish('aborted');
    const timer = setTimeout(() => finish('none'), wait);
    signal?.addEventListener('abort', stop, { once: true });
    channel.onmessage = ({ data }) => {
      if (data?.marker === marker && (data.type === 'held' || data.type === 'none'))
        finish(data.type);
    };
    channel.postMessage({ type: 'hold', marker });
  });
}

function opened(connection, { is, storage }) {
  const urls = new Map();
  const consider = (info) => {
    if (info.type !== 'page' || !info.openerId || !/^about:blank(?:#|$)/.test(info.url ?? ''))
      return;
    const opener = urls.get(info.openerId);
    if (isHeld(info.openerId, storage) || (opener !== undefined && is.url(opener)))
      hold(info.targetId, storage);
  };
  let next = 0;
  connection.onmessage = (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const infos = (message.result?.targetInfos ?? [message.params?.targetInfo]).filter(
      (info) => info?.targetId
    );
    for (const info of infos) urls.set(info.targetId, info.url ?? '');
    for (const info of infos) consider(info);
  };
  const send = (method, params = {}) => {
    next += 1;
    connection.send(JSON.stringify({ id: next, method, params }));
  };
  send('Target.setDiscoverTargets', { discover: true });
  const poll = () => send('Target.getTargets');
  poll();
  return poll;
}

export function watchOpened({
  hosts,
  own,
  is = protectedOrigins(catalog.protectedOrigins, own ? [own] : []),
  storage = globalThis.localStorage,
  every = 250,
  timers = globalThis,
}) {
  const live = new Map();
  const ended = new Set();
  const look = async () => {
    for (const [name, open] of Object.entries(hosts() ?? {})) {
      if (typeof open !== 'function' || ended.has(name)) continue;
      if (live.has(name)) {
        live.get(name)?.poll();
        continue;
      }
      live.set(name, null);
      try {
        const connection = await open();
        const poll = opened(connection, { is, storage });
        live.set(name, { connection, poll });
        connection.onclose = () => {
          live.delete(name);
          ended.add(name);
        };
      } catch {
        live.delete(name);
      }
    }
  };
  void look();
  const timer = timers.setInterval(() => void look(), every);
  return {
    poke() {
      ended.clear();
    },
    stop() {
      timers.clearInterval(timer);
      for (const entry of live.values()) entry?.connection.close();
      live.clear();
    },
  };
}
