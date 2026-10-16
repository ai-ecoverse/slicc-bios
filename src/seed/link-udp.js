export const UDP_DATAGRAM = 1;
export const UDP_UNREACHABLE = 2;
export const UDP_MAX = { 4: 65507, 6: 65527 };
export const UDP_QUEUED = 512;
export const UDP_QUEUED_BYTES = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const refused = (message, code) => Object.assign(new Error(message), { code });

export function udpRecord(type, host, port, payload) {
  const name = encoder.encode(host);
  const out = new Uint8Array(9 + name.length + payload.length);
  const view = new DataView(out.buffer);
  out[0] = type;
  view.setUint16(1, name.length);
  out.set(name, 3);
  view.setUint16(3 + name.length, port);
  view.setUint32(5 + name.length, payload.length);
  out.set(payload, 9 + name.length);
  return out;
}

export function udpCode(text) {
  return /^E[A-Z0-9]+\b/.exec(text)?.[0] ?? 'EHOSTUNREACH';
}

export function fitsFamily(host, family) {
  if (family === 4) return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return (
    host.includes(':') && !host.includes('%') && !/^::ffff:/i.test(host) && !host.includes('.')
  );
}

export function datagrams() {
  const items = [];
  const waiters = [];
  let size = 0;
  let ended = false;
  const length = (item) => item.bytes?.length ?? 0;
  const queue = {
    push(item) {
      if (ended) return false;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: item, done: false });
        return true;
      }
      if (items.length >= UDP_QUEUED || size + length(item) > UDP_QUEUED_BYTES) return false;
      size += length(item);
      items.push(item);
      return true;
    },
    end() {
      ended = true;
      items.length = 0;
      size = 0;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    get ended() {
      return ended;
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
        return() {
          queue.end();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return queue;
}

async function records(reader, each) {
  for (;;) {
    let type;
    try {
      type = (await reader.take(1))[0];
    } catch {
      return 'end';
    }
    const name = new DataView((await reader.take(2)).buffer).getUint16(0);
    const host = decoder.decode(await reader.take(name));
    const port = new DataView((await reader.take(2)).buffer).getUint16(0);
    const length = new DataView((await reader.take(4)).buffer).getUint32(0);
    if (length > UDP_MAX[6]) return 'violation';
    const payload = length ? await reader.take(length) : new Uint8Array(0);
    if (type === UDP_DATAGRAM) each({ bytes: payload, host, port });
    else if (type === UDP_UNREACHABLE)
      each({ error: udpCode(decoder.decode(payload)), host, port });
    else return 'violation';
  }
}

export async function linkUdp(
  session,
  { family, signal, local = (host) => host, remote = (host) => host },
  reader
) {
  signal?.throwIfAborted();
  const s = await session.open({ kind: 'udp', family });
  if (signal?.aborted) {
    s.close();
    signal.throwIfAborted();
  }
  const messages = datagrams();
  let closed = false;
  let dropped = 0;
  const close = () => {
    signal?.removeEventListener('abort', close);
    messages.end();
    if (closed) return;
    closed = true;
    s.closeWrite();
  };
  signal?.addEventListener('abort', close, { once: true });
  records(reader(s), (message) => {
    if (closed || !messages.push({ ...message, host: local(message.host) })) dropped += 1;
  })
    .then((how) => {
      if (how === 'violation') s.reset('EPROTO');
      else close();
    })
    .catch(() => s.reset('EPROTO'))
    .finally(() => {
      messages.end();
      closed = true;
    });
  return {
    localAddr: String(s.info.localAddr ?? ''),
    get dropped() {
      return dropped;
    },
    messages,
    close,
    async send(bytes, host, port) {
      if (closed || messages.ended)
        throw refused('the UDP socket on the link closed', 'ENETUNREACH');
      if (!fitsFamily(host, family))
        throw refused(`${host} is no IPv${family} address`, 'ENETUNREACH');
      if (bytes.length > UDP_MAX[family])
        throw refused('a datagram over the UDP limit', 'EMSGSIZE');
      const record = udpRecord(UDP_DATAGRAM, remote(host), port, bytes);
      if (record.length > s.room) {
        dropped += 1;
        return;
      }
      await s.write(record);
    },
  };
}
