import { REVOKED } from './followers.js';
import { device, MAX_CDP_MESSAGE } from './link.js';
import { displayName } from './tray.js';

export const CDP_QUEUE = 64 * 1024 * 1024;
export const LINGER_MS = 5000;
export const VERSION_ID = -2;
export const SWITCH_KEY = 'remote-browser';
export const SWITCH_LABEL = 'Browser control from linked devices';
export const SWITCHED_OFF =
  "EACCES: browser control from linked devices is off in seven's settings";
export const NO_GRANT =
  "EACCES: browser control from this device is off; turn on Browser for it in seven's Linked devices";
export const NOT_CLI = 'EACCES: only a slicc CLI can drive this browser';
export const STOPPED = 'ECONNRESET: stopped in seven';
export const TOO_BIG = 'EMSGSIZE: a CDP message over 64 MiB';
export const CUT = 'EPROTO: the node ended inside a CDP message';
export const FULL = 'ENOBUFS: over 64 MiB of CDP messages wait for the node';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function cdpFrames(limit = MAX_CDP_MESSAGE) {
  const chunks = [];
  let size = 0;
  let want = null;
  const take = (n) => {
    const out = new Uint8Array(n);
    for (let at = 0; at < n; ) {
      const chunk = chunks[0];
      const k = Math.min(chunk.length, n - at);
      out.set(chunk.subarray(0, k), at);
      at += k;
      if (k === chunk.length) chunks.shift();
      else chunks[0] = chunk.subarray(k);
    }
    size -= n;
    return out;
  };
  return {
    partial: () => want !== null || size > 0,
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      const out = [];
      for (;;) {
        if (want === null) {
          if (size < 4) return out;
          want = new DataView(take(4).buffer).getUint32(0);
          if (want > limit) return null;
        }
        if (size < want) return out;
        out.push(decoder.decode(take(want)));
        want = null;
      }
    },
  };
}

export function cdpFrame(text) {
  const body = encoder.encode(text);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export function createCdpIn({
  hook,
  allowed,
  on = () => true,
  live = null,
  timers = globalThis,
  now = Date.now,
  limit = MAX_CDP_MESSAGE,
  queue = CDP_QUEUE,
}) {
  const open = new Set();
  const shown = new Map();
  const keyOf = (link) => link.id ?? link.key;
  const nameOf = (link) => displayName(device(link).name);
  const reset = (match, text) => {
    for (const entry of [...open]) if (match(entry)) entry.stream.reset(text);
  };

  function show(entry) {
    const { key } = entry;
    let item = shown.get(key);
    if (!item) {
      item = { count: 0, timer: null };
      item.remove =
        live?.add({
          kind: 'cdp',
          label: 'Driving this browser',
          what: '',
          asker: nameOf(entry.link),
          since: now(),
          action: { label: 'Stop', run: () => reset((other) => other.key === key, STOPPED) },
        }) ?? (() => {});
      shown.set(key, item);
    }
    timers.clearTimeout(item.timer);
    item.count += 1;
    return () => {
      item.count -= 1;
      if (item.count > 0) return;
      item.timer = timers.setTimeout(() => {
        if (item.count > 0 || shown.get(key) !== item) return;
        shown.delete(key);
        item.remove();
      }, LINGER_MS);
    };
  }

  function relay(entry, connection) {
    const s = entry.stream;
    let writes = Promise.resolve();
    let waiting = 0;
    let opened = false;
    const early = [];
    const out = (text) => {
      const framed = cdpFrame(text);
      if (framed.length - 4 > limit) return s.reset(TOO_BIG);
      waiting += framed.length;
      if (waiting > queue) return s.reset(FULL);
      writes = writes
        .then(() => s.write(framed))
        .then(
          () => {
            waiting -= framed.length;
          },
          () => {}
        );
    };
    const inbound = async () => {
      const frames = cdpFrames(limit);
      for (let chunk = await s.read(); chunk; chunk = await s.read()) {
        const texts = frames.push(chunk);
        if (!texts) return s.reset(TOO_BIG);
        for (const text of texts) connection.send(text);
      }
      if (frames.partial()) return s.reset(CUT);
      entry.ending = true;
      entry.close();
      await writes;
      s.closeWrite();
    };
    connection.onclose = (reason) => {
      if (!entry.ending) s.reset(`ECONNRESET: ${reason || 'the browser closed'}`);
    };
    connection.onmessage = (text) => {
      if (opened) return out(text);
      const message = parsed(text);
      if (message?.id !== VERSION_ID) return void early.push(text);
      if (message.error)
        return s.reset(`EIO: ${message.error.message ?? 'Browser.getVersion failed'}`);
      opened = true;
      s.accepted({ version: message.result ?? {} });
      entry.hide = show(entry);
      for (const text of early.splice(0)) out(text);
      inbound().catch(() => {});
    };
    connection.send(JSON.stringify({ id: VERSION_ID, method: 'Browser.getVersion' }));
  }

  async function serve(link, s) {
    if (link.kind !== 'cli') return s.reset(NOT_CLI);
    if (!on()) return s.reset(SWITCHED_OFF);
    if (!allowed(link)) return s.reset(NO_GRANT);
    const entry = { link, key: keyOf(link), stream: s, ending: false, close: () => {} };
    open.add(entry);
    s.settled.then(() => {
      open.delete(entry);
      entry.close();
      entry.hide?.();
    });
    let connection;
    try {
      connection = await hook({ caller: { kind: 'device', id: entry.key, name: nameOf(link) } });
    } catch (error) {
      return s.reset(`ENOENT: ${error.message}`);
    }
    let closed = false;
    entry.close = () => {
      if (closed) return;
      closed = true;
      connection.close();
    };
    if (!open.has(entry)) return entry.close();
    relay(entry, connection);
  }

  return {
    accept: (link) => ({ handle: (s) => serve(link, s) }),
    revoked: () => reset((entry) => !allowed(entry.link), REVOKED),
    off: () => reset(() => true, SWITCHED_OFF),
  };
}
