import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const CHANNEL = 'slicc-held';
export const KEY = 'slicc-os.held-targets';
export const MARK = 'slicc-sign-in-';
export const LINKED = 'link:';
export const KEEP = 32;
export const WAIT = 5000;
export const FLIGHT = 11 * 60 * 1000;
export const UNSWEPT =
  "Seven couldn't check the browser for sign-in tabs before handing it over. Try again.";
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
export const emptyNoAccess = (info) => info.url === '' && info.canAccessOpener === false;

export function crossOriginPage(info, openerUrl) {
  const page = info.type === 'page' && URL.parse(info.url);
  const opener = URL.parse(openerUrl);
  return Boolean(
    page &&
      ['http:', 'https:'].includes(page.protocol) &&
      opener &&
      page.origin !== 'null' &&
      opener.origin !== 'null' &&
      page.origin !== opener.origin
  );
}

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

const BLANK = /^(?:about:blank)?$/;

function redactedPopup(info, infos, is) {
  if (!BLANK.test(info.url ?? '') || typeof info.openerId !== 'string') return false;
  const opener = infos.find((one) => one?.targetId === info.openerId);
  return opener?.type === 'page' && is.url(opener.url ?? '');
}

async function listing(open) {
  let connection;
  try {
    connection = await open();
  } catch {
    return null;
  }
  try {
    const result = await ask(connection, 'Target.getTargets');
    if (!Array.isArray(result?.targetInfos)) return null;
    return new Set(result.targetInfos.map((info) => info?.targetId));
  } finally {
    connection.close();
  }
}

async function find(open, url, { deadline, now, sleep, storage, redacted, before }) {
  if (before === null) return 'missing';
  let connection;
  try {
    connection = await open();
  } catch {
    return 'missing';
  }
  try {
    for (;;) {
      const result = await ask(connection, 'Target.getTargets');
      const infos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
      const found = infos.filter(
        (info) =>
          info?.type === 'page' &&
          typeof info.targetId === 'string' &&
          (info.url === url ||
            (redacted && !before?.has(info.targetId) && redactedPopup(info, infos, redacted)))
      );
      if (found.length) {
        for (const info of found) hold(info.targetId, storage);
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
  own = globalThis.location?.origin,
  is = guardOf(own),
  storage = globalThis.localStorage,
  listen = (name) => new BroadcastChannel(name),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  wait = WAIT,
  asked = () => {},
}) {
  const channel = listen(CHANNEL);
  const bases = new Map();
  const queued = new Set();
  let turn = Promise.resolve();
  const openers = () =>
    Object.entries(hosts() ?? {}).filter(([, open]) => typeof open === 'function');
  const base = async (marker) => {
    const linked = openers().filter(([name]) => name.startsWith(LINKED));
    const lists = await Promise.all(
      linked.map(async ([name, open]) => [name, await listing(open)])
    );
    const entry = { lists: new Map(lists) };
    const done = new Promise((resolve) => {
      entry.release = resolve;
    });
    bases.set(marker, entry);
    channel.postMessage({ type: 'based', marker });
    void sleep(wait).then(() => {
      if (bases.get(marker) !== entry) return;
      bases.delete(marker);
      entry.release();
    });
    await done;
  };
  const claim = (marker) => {
    const entry = bases.get(marker) ?? { lists: new Map(), release() {} };
    bases.delete(marker);
    return entry;
  };
  channel.onmessage = async ({ data }) => {
    if (typeof data?.marker !== 'string' || !data.marker) return;
    if (data.type === 'base') {
      if (queued.has(data.marker)) return;
      queued.add(data.marker);
      turn = turn
        .then(() => base(data.marker))
        .catch(() => {})
        .then(() => queued.delete(data.marker));
      return;
    }
    if (data.type !== 'hold') return;
    asked();
    const url = markerUrl(data.marker);
    const deadline = now() + wait;
    const entry = data.based === true ? claim(data.marker) : undefined;
    const found = await Promise.all(
      openers().map(([name, open]) => {
        const linked = name.startsWith(LINKED);
        return find(open, url, {
          deadline,
          now,
          sleep,
          storage,
          redacted: linked && is,
          before: linked && entry ? (entry.lists.get(name) ?? null) : undefined,
        });
      })
    );
    entry?.release();
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

export function askBase(
  marker,
  {
    listen = (name) => new BroadcastChannel(name),
    wait = WAIT + 1000,
    signal,
    present = () => false,
  } = {}
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
    const timer = setTimeout(() => finish(present() ? 'unheld' : 'none'), wait);
    signal?.addEventListener('abort', stop, { once: true });
    channel.onmessage = ({ data }) => {
      if (data?.marker === marker && data.type === 'based') finish('based');
    };
    channel.postMessage({ type: 'base', marker });
  });
}

export function askHold(
  marker,
  {
    listen = (name) => new BroadcastChannel(name),
    wait = WAIT + 1000,
    signal,
    present = () => false,
    now = Date.now,
    based = false,
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
    channel.postMessage({ type: 'hold', marker, ...(based ? { based } : {}) });
  });
}

function considering({ is, storage, now }) {
  const targets = new Map();
  const holds = (info, all, fresh) => {
    if (isHeld(info.targetId, storage)) return false;
    if (isHeld(info.parentId, storage) || isHeld(info.openerId, storage)) return true;
    if (info.type !== 'page' || !info.openerId) return false;
    if (!all && !info.canAccessOpener && !/^about:(?:blank|srcdoc)(?:#|$)/.test(info.url ?? ''))
      return false;
    const opener = targets.get(info.openerId);
    const current = fresh.get(info.openerId);
    const cross =
      current?.type === 'page' &&
      /^https?:/i.test(current.url) &&
      is.url(current.url) &&
      crossOriginPage(info, current.url);
    if (!all && cross) return false;
    return opener !== undefined && is.url(opener.url);
  };
  return (infos) => {
    const known = infos.filter((info) => info?.targetId);
    const fresh = new Map(known.map((info) => [info.targetId, info]));
    for (const info of known)
      targets.set(info.targetId, { ...targets.get(info.targetId), ...info });
    const all = inFlight(now, storage);
    for (let added = true; added; ) {
      added = false;
      for (const info of known) {
        if (!holds(info, all, fresh)) continue;
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
}) {
  const live = new Map();
  const ended = new Set();
  let wanted = false;
  const look = async () => {
    for (const [name, open] of Object.entries(hosts() ?? {})) {
      if (typeof open !== 'function' || ended.has(name)) continue;
      if (!wanted) continue;
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
