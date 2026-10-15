export const WS_TEXT = 1;
export const WS_BINARY = 2;
export const WS_CLOSE = 8;
export const WS_MAX = 64 * 1024 * 1024;
export const WS_QUEUED = 16 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function wsRecord(type, payload) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

export function cut(reason, limit) {
  const bytes = encoder.encode(reason ?? '');
  if (bytes.length <= limit) return bytes;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

export function closePayload(code, reason) {
  const text = cut(reason, 123);
  const out = new Uint8Array(2 + text.length);
  new DataView(out.buffer).setUint16(0, code);
  out.set(text, 2);
  return out;
}

export const sendable = (code) =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    ? code
    : 1000;

export function inbox(onOverflow) {
  const items = [];
  const waiters = [];
  let size = 0;
  let ended = false;
  const length = (item) => (typeof item === 'string' ? item.length * 2 : item.length);
  return {
    push(item) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) return waiter({ value: item, done: false });
      size += length(item);
      items.push(item);
      if (size > WS_QUEUED) {
        ended = true;
        items.length = 0;
        size = 0;
        onOverflow();
      }
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length) {
            const value = items.shift();
            size -= length(value);
            return Promise.resolve({ value, done: false });
          }
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

async function records(reader, each) {
  for (;;) {
    let head;
    try {
      head = await reader.take(5);
    } catch {
      return null;
    }
    const length = new DataView(head.buffer).getUint32(1);
    if (length > WS_MAX) return { code: 1009, reason: 'a message over 64 MiB' };
    const payload = length ? await reader.take(length) : new Uint8Array(0);
    if (head[0] === WS_CLOSE) {
      const code = payload.length >= 2 ? new DataView(payload.buffer).getUint16(0) : 1005;
      return { code, reason: decoder.decode(payload.subarray(2)) };
    }
    if (head[0] === WS_TEXT) each(decoder.decode(payload));
    else if (head[0] === WS_BINARY) each(payload);
    else return { code: 1002, reason: 'an unknown record from the node' };
  }
}

export async function linkWebSocket(session, { url, protocols, headers, signal }, reader) {
  signal?.throwIfAborted();
  const s = await session.open({ kind: 'ws', url, protocols, headers });
  if (signal?.aborted) {
    s.close();
    signal.throwIfAborted();
  }
  let state = 'open';
  let buffered = 0;
  let writes = Promise.resolve();
  let settle;
  const closed = new Promise((resolve) => {
    settle = resolve;
  });
  const write = (bytes) => {
    buffered += bytes.length;
    writes = writes
      .then(() => s.write(bytes))
      .catch(() => {})
      .finally(() => {
        buffered -= bytes.length;
      });
    return writes;
  };
  const messages = inbox(() => socket.close(1009, 'too many waiting messages'));
  const finish = (result) => {
    if (state === 'closed') return;
    state = 'closed';
    messages.end();
    settle(result);
    writes.then(() => s.close());
  };
  const close = (code, reason) => {
    if (state !== 'open') return;
    state = 'closing';
    void write(wsRecord(WS_CLOSE, closePayload(sendable(code), reason))).then(() => s.closeWrite());
  };
  const abort = () => close(1001, 'the request was aborted');
  signal?.addEventListener('abort', abort, { once: true });
  const socket = {
    protocol: String(s.info.protocol ?? ''),
    get buffered() {
      return buffered;
    },
    send(data) {
      if (state !== 'open')
        throw Object.assign(new Error('the WebSocket is closed'), { code: 'EPIPE' });
      const text = typeof data === 'string';
      const payload = text ? encoder.encode(data) : data;
      if (payload.length > WS_MAX) {
        close(1009, 'a message over 64 MiB');
        throw Object.assign(new Error('a WebSocket message over 64 MiB'), { code: 'EMSGSIZE' });
      }
      void write(wsRecord(text ? WS_TEXT : WS_BINARY, payload));
    },
    messages,
    close,
    closed,
  };
  records(reader(s), (message) => messages.push(message))
    .then((result) => {
      signal?.removeEventListener('abort', abort);
      if (result && state === 'open') {
        state = 'closing';
        void write(wsRecord(WS_CLOSE, closePayload(sendable(result.code), result.reason)));
      }
      finish(result ?? { code: 1006, reason: 'the link closed' });
    })
    .catch(() => finish({ code: 1006, reason: 'the link closed' }));
  return socket;
}
