import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const CHANNEL = 'slicc-held';
export const KEY = 'slicc-os.held-targets';
export const MARK = 'slicc-sign-in-';
export const KEEP = 32;
export const WAIT = 5000;
export const FLIGHT = 11 * 60 * 1000;
export const UNHELD =
  "Seven couldn't keep the sign-in window out of reach of browser automation, so it didn't open the sign-in. Try again.";
const EVERY = 200;

const held = new Set();
const flights = [];

export function flying(now = Date.now) {
  flights.push(now() + FLIGHT);
}

export function inFlight(now = Date.now) {
  while (flights.length && flights[0] <= now()) flights.shift();
  return flights.length > 0;
}

export const guardOf = (own) => protectedOrigins(catalog.protectedOrigins, own ? [own] : []);

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

async function find(open, url, { deadline, now, sleep, storage }) {
  let connection;
  try {
    connection = await open();
  } catch {
    return 'absent';
  }
  try {
    for (;;) {
      const result = await ask(connection, 'Target.getTargets');
      const found = result?.targetInfos?.find((info) => info.type === 'page' && info.url === url);
      if (found) {
        hold(found.targetId, storage);
        return 'held';
      }
      if (!result || now() >= deadline) return 'missing';
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
    const found = (
      await Promise.all(opens.map((open) => find(open, url, { deadline, now, sleep, storage })))
    ).filter((state) => state !== 'absent');
    const type = !found.length
      ? 'none'
      : found.every((state) => state === 'held')
        ? 'held'
        : 'unheld';
    if (type === 'none') flying(now);
    channel.postMessage({ type, marker: data.marker });
  };
  return () => channel.close();
}

const ANSWERS = new Set(['held', 'none', 'unheld']);

export function askHold(
  marker,
  {
    listen = (name) => new BroadcastChannel(name),
    wait = WAIT + 1000,
    signal,
    present = () => false,
    now = Date.now,
  } = {}
) {
  return new Promise((resolve) => {
    const channel = listen(CHANNEL);
    const finish = (answer) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      channel.close();
      if (answer === 'none') flying(now);
      resolve(answer);
    };
    const stop = () => finish('aborted');
    const timer = setTimeout(() => finish(present() ? 'unheld' : 'none'), wait);
    signal?.addEventListener('abort', stop, { once: true });
    channel.onmessage = ({ data }) => {
      if (data?.marker === marker && ANSWERS.has(data.type)) finish(data.type);
    };
    channel.postMessage({ type: 'hold', marker });
  });
}

function considering({ is, storage, now }) {
  const urls = new Map();
  return (infos) => {
    const known = infos.filter((info) => info?.targetId);
    for (const info of known) urls.set(info.targetId, info.url ?? '');
    const all = inFlight(now);
    for (const info of known) {
      if (info.type !== 'page' || !info.openerId) continue;
      if (!all && !info.canAccessOpener && !/^about:blank(?:#|$)/.test(info.url ?? '')) continue;
      const opener = urls.get(info.openerId);
      if (isHeld(info.openerId, storage) || (opener !== undefined && is.url(opener)))
        hold(info.targetId, storage);
    }
  };
}

export async function sweep({ hosts, own, is = guardOf(own), storage, now = Date.now }) {
  const consider = considering({ is, storage, now });
  for (const open of Object.values(hosts() ?? {})) {
    if (typeof open !== 'function') continue;
    let connection;
    try {
      connection = await open();
    } catch {
      continue;
    }
    try {
      consider((await ask(connection, 'Target.getTargets'))?.targetInfos ?? []);
    } finally {
      connection.close();
    }
  }
}

function opened(connection, { is, storage, now }) {
  const consider = considering({ is, storage, now });
  let next = 0;
  connection.onmessage = (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    consider(message.result?.targetInfos ?? [message.params?.targetInfo]);
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
  is = guardOf(own),
  storage = globalThis.localStorage,
  every = 250,
  timers = globalThis,
  now = Date.now,
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
        const poll = opened(connection, { is, storage, now });
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
