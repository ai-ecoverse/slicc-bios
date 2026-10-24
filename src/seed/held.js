import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const CHANNEL = 'slicc-held';
export const KEY = 'slicc-os.held-targets';
export const MARK = 'slicc-sign-in-';
export const KEEP = 32;
export const WAIT = 5000;
export const FLIGHT = 11 * 60 * 1000;
export const UNSWEPT =
  "seven couldn't check the browser for sign-in tabs before handing it over; try again";
export const UNHELD =
  "Seven couldn't keep the sign-in window out of reach of browser automation, so it didn't open the sign-in. Try again.";
const EVERY = 200;

const held = new Set();
export const FLIGHT_KEY = 'slicc-os.sign-in-flight';

export function flying(now = Date.now, storage = globalThis.localStorage) {
  try {
    storage?.setItem(FLIGHT_KEY, String(now() + FLIGHT));
  } catch {}
}

export function landed(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(FLIGHT_KEY);
  } catch {}
}

export function inFlight(now = Date.now, storage = globalThis.localStorage) {
  return Number(storage?.getItem(FLIGHT_KEY) ?? 0) > now();
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
  held.add(targetId);
  const now = stored(storage);
  if (now.at(-1) === targetId) return;
  const list = [...now.filter((id) => id !== targetId), targetId].slice(-KEEP);
  try {
    storage?.setItem(KEY, JSON.stringify(list));
  } catch {}
}

export function markerUrl(marker) {
  return `about:blank#${MARK}${marker}`;
}

export const ASK = 10000;

function ask(connection, method, params = {}, timers = globalThis) {
  return new Promise((resolve) => {
    const id = 1;
    const timer = timers.setTimeout(() => resolve(null), ASK);
    connection.onmessage = (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id !== id) return;
      timers.clearTimeout(timer);
      resolve(message.result ?? null);
    };
    connection.onclose = () => {
      timers.clearTimeout(timer);
      resolve(null);
    };
    connection.send(JSON.stringify({ id, method, params }));
  });
}

async function find(open, url, { deadline, now, sleep, storage }) {
  let connection;
  try {
    connection = await open();
  } catch {
    return 'missing';
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
  asked = () => {},
}) {
  const channel = listen(CHANNEL);
  channel.onmessage = async ({ data }) => {
    if (data?.type !== 'hold' || typeof data.marker !== 'string' || !data.marker) return;
    asked();
    const url = markerUrl(data.marker);
    const deadline = now() + wait;
    const opens = Object.values(hosts() ?? {}).filter((open) => typeof open === 'function');
    const found = await Promise.all(
      opens.map((open) => find(open, url, { deadline, now, sleep, storage }))
    );
    const type = !found.length
      ? 'none'
      : found.every((state) => state === 'held')
        ? 'held'
        : 'unheld';
    if (type === 'none') flying(now, storage);
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
      const sure = answer === 'none' && present() ? 'unheld' : answer;
      if (sure === 'none') flying(now);
      resolve(sure);
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
  const holds = (info, all) => {
    if (isHeld(info.targetId, storage)) return false;
    if (isHeld(info.parentId, storage) || isHeld(info.openerId, storage)) return true;
    if (info.type !== 'page' || !info.openerId) return false;
    if (!all && !info.canAccessOpener && !/^about:blank(?:#|$)/.test(info.url ?? '')) return false;
    const opener = urls.get(info.openerId);
    return opener !== undefined && is.url(opener);
  };
  return (infos) => {
    const known = infos.filter((info) => info?.targetId);
    for (const info of known) urls.set(info.targetId, info.url ?? '');
    const all = inFlight(now, storage);
    for (let added = true; added; ) {
      added = false;
      for (const info of known) {
        if (!holds(info, all)) continue;
        hold(info.targetId, storage);
        added = true;
      }
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
      throw new Error(UNSWEPT);
    }
    try {
      const listed = await ask(connection, 'Target.getTargets');
      if (!Array.isArray(listed?.targetInfos)) throw new Error(UNSWEPT);
      consider(listed.targetInfos);
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
  eager = [],
}) {
  const live = new Map();
  const ended = new Set();
  let wanted = false;
  const look = async () => {
    for (const [name, open] of Object.entries(hosts() ?? {})) {
      if (typeof open !== 'function' || ended.has(name)) continue;
      if (!wanted && !eager.includes(name)) continue;
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
      wanted = true;
      ended.clear();
      void look();
    },
    stop() {
      timers.clearInterval(timer);
      for (const entry of live.values()) entry?.connection.close();
      live.clear();
    },
  };
}
