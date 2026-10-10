import { bareHost } from './exits.js';

export const OPEN = 1;
export const OPENED = 2;
export const DATA = 3;
export const END = 4;
export const RESET = 5;
export const CREDIT = 6;
export const WINDOW = 256 * 1024;
export const CHUNK = 64 * 1024;
export const HELLO_MS = 10_000;
export const CONTROL = 'slicc.link.v1';
export const STREAM = 'slicc.link.v1.stream';
export const SUBNET = '198.18.57';
export const FIRST = 11;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function frame(type, id, payload = new Uint8Array(0)) {
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const out = new Uint8Array(5 + bytes.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, id);
  out.set(bytes, 5);
  return out;
}

export function parse(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 5 || bytes[0] < OPEN || bytes[0] > CREDIT) return null;
  const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
  return { type: bytes[0], id, payload: bytes.subarray(5) };
}

export function failure(text) {
  const at = text.indexOf(': ');
  const code = at < 0 ? text : text.slice(0, at);
  return Object.assign(new Error(at < 0 ? text : text.slice(at + 2)), { code });
}

const u32 = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

const json = (bytes) => {
  try {
    return bytes.length ? JSON.parse(decoder.decode(bytes)) : {};
  } catch {
    return null;
  }
};

function opened(channel) {
  if (channel.readyState === 'open') return Promise.resolve(channel);
  return new Promise((resolve, reject) => {
    channel.addEventListener('open', () => resolve(channel), { once: true });
    channel.addEventListener('close', () => reject(failure('ECONNRESET: the channel closed')), {
      once: true,
    });
  });
}

function stream(streams, id, channel, own) {
  const state = { opened: false, sentEnd: false, gotEnd: false, unacked: 0, held: 0 };
  const chunks = [];
  const waiting = new Set();
  let error = null;
  let info = null;
  let answer;
  const answered = new Promise((resolve, reject) => {
    answer = { resolve, reject };
  });
  answered.catch(() => {});
  const wake = () => {
    for (const resume of [...waiting]) resume();
  };
  const wait = () =>
    new Promise((resolve) => {
      const resume = () => {
        waiting.delete(resume);
        resolve();
      };
      waiting.add(resume);
    });
  const send = (type, payload) => {
    if (channel.readyState === 'open') channel.send(frame(type, id, payload));
  };
  const done = () => {
    streams.delete(id);
    if (own) channel.close();
  };
  const fail = (reason) => {
    error = reason;
    answer.reject(reason);
    wake();
    done();
  };
  const violate = () => {
    send(RESET, 'EPROTO');
    fail(failure('EPROTO: the node broke the link protocol'));
  };
  const over = () => {
    if (state.sentEnd && state.gotEnd) done();
  };
  const handlers = {
    [OPENED]: (payload) => {
      if (state.opened) return violate();
      state.opened = true;
      info = json(payload) ?? {};
      answer.resolve(api);
    },
    [DATA]: (payload) => {
      if (!state.opened || state.gotEnd || payload.length === 0) return violate();
      if (state.held + payload.length > WINDOW) return violate();
      state.held += payload.length;
      chunks.push(payload.slice());
      wake();
    },
    [END]: () => {
      if (!state.opened || state.gotEnd) return violate();
      state.gotEnd = true;
      wake();
      over();
    },
    [RESET]: (payload) => fail(failure(decoder.decode(payload) || 'ECONNRESET')),
    [CREDIT]: (payload) => {
      const n =
        payload.length === 4 ? new DataView(payload.buffer, payload.byteOffset).getUint32(0) : 0;
      if (n < 1 || n > state.unacked) return violate();
      state.unacked -= n;
      wake();
    },
  };
  const api = {
    id,
    channel,
    get info() {
      return info;
    },
    answered,
    receive: (type, payload) => handlers[type](payload),
    fail,
    async read() {
      while (!chunks.length && !error && !state.gotEnd) await wait();
      if (chunks.length) {
        const chunk = chunks.shift();
        state.held -= chunk.length;
        send(CREDIT, u32(chunk.length));
        return chunk;
      }
      if (error) throw error;
      return null;
    },
    async write(bytes) {
      for (let at = 0; at < bytes.length; ) {
        if (error) throw error;
        if (state.sentEnd) throw failure('EPIPE: the stream was closed for writing');
        const room = WINDOW - state.unacked;
        if (room <= 0) {
          await wait();
          continue;
        }
        const piece = bytes.subarray(at, at + Math.min(CHUNK, room));
        state.unacked += piece.length;
        send(DATA, piece);
        at += piece.length;
      }
      return bytes.length;
    },
    closeWrite() {
      if (error || state.sentEnd) return;
      state.sentEnd = true;
      send(END);
      over();
    },
    close() {
      if (!streams.has(id)) return;
      send(RESET, 'ECONNRESET');
      fail(failure('ECONNRESET: closed'));
    },
  };
  return api;
}

export function createSession({ control, createChannel, hello, timers = globalThis, onClose }) {
  const streams = new Map();
  const peerIds = new Set();
  const channels = new Set();
  let next = 1;
  let peer = null;
  let closed = null;
  let timer = null;
  let settle;
  const ready = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  ready.catch(() => {});

  function close(reason) {
    if (closed) return;
    closed = reason;
    timers.clearTimeout(timer);
    settle.reject(failure(`ECONNRESET: ${reason}`));
    for (const stream of [...streams.values()]) stream.fail(failure(`ECONNRESET: ${reason}`));
    for (const channel of [...channels]) channel.close();
    onClose?.(reason);
  }

  function receive(channel, data) {
    if (closed) return;
    if (typeof data === 'string') {
      if (channel !== control || peer) return close('a text message after HELLO');
      const parsed = json(encoder.encode(data));
      if (parsed?.role !== 'node') return close('a malformed HELLO');
      peer = parsed;
      timers.clearTimeout(timer);
      settle.resolve(peer);
      return;
    }
    if (!peer) return close('a frame before HELLO');
    const parsed = parse(data);
    if (!parsed || parsed.id === 0) return close('a malformed frame');
    const { type, id, payload } = parsed;
    if (type === OPEN) {
      if (id % 2 === 1 || peerIds.has(id)) return close('an OPEN with a bad stream id');
      peerIds.add(id);
      channel.send(frame(RESET, id, 'EOPNOTSUPP'));
      return;
    }
    streams.get(id)?.receive(type, payload);
  }

  function adopt(channel) {
    channels.add(channel);
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', (event) => receive(channel, event.data));
    channel.addEventListener('close', () => {
      channels.delete(channel);
      if (channel === control) return close('the control channel closed');
      for (const s of [...streams.values()]) {
        if (s.channel === channel) s.fail(failure('ECONNRESET: the stream channel closed'));
      }
    });
    return channel;
  }

  adopt(control);
  opened(control).then(
    () => {
      if (closed) return;
      control.send(JSON.stringify({ v: 1, role: 'page', ...hello }));
      timer = timers.setTimeout(() => close('no HELLO from the node within 10 s'), HELLO_MS);
    },
    () => {}
  );

  return {
    ready,
    adopt,
    close,
    peer: () => peer,
    closed: () => closed,
    caps: () => (Array.isArray(peer?.caps) ? peer.caps : []),
    async open(meta, { shared = false } = {}) {
      await ready;
      const id = next;
      next += 2;
      const channel = shared ? control : await opened(adopt(createChannel(STREAM)));
      if (closed) throw failure(`ECONNRESET: ${closed}`);
      const s = stream(streams, id, channel, !shared);
      streams.set(id, s);
      channel.send(frame(OPEN, id, JSON.stringify(meta)));
      return s.answered;
    },
  };
}

export function bufferedReader(stream) {
  let buffer = new Uint8Array(0);
  const fill = async (n) => {
    while (buffer.length < n) {
      const chunk = await stream.read();
      if (chunk === null) throw failure('EPROTO: the response ended early');
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
    }
  };
  return {
    async take(n) {
      await fill(n);
      const out = buffer.slice(0, n);
      buffer = buffer.subarray(n);
      return out;
    },
    async next() {
      if (buffer.length) {
        const out = buffer;
        buffer = new Uint8Array(0);
        return out;
      }
      return stream.read();
    },
  };
}

const mapped = (error) =>
  error.code === 'ENOTFOUND' ? Object.assign(error, { code: 'EHOSTUNREACH' }) : error;

export function linkExit(session, { id, address, label }) {
  const name = () => `${label()}.slicc.internal`;
  const mine = (host) => {
    const bare = bareHost(host).replace(/\.$/, '');
    return bare === address || bare === name();
  };
  const hello = () => session.peer();
  return {
    id,
    kind: 'link',
    chosenOnly: true,
    address,
    name,
    active: () => Boolean(hello()) && !session.closed(),
    offersDefault: () => Boolean(hello()?.routes?.exit) && session.caps().includes('net'),
    claims: mine,
    prefixes: () => [`${address}/32`],
    knows: (query) => (query.replace(/\.$/, '').toLowerCase() === name() ? [address] : null),
    async resolve(query, family) {
      if (!session.caps().includes('net')) return [];
      const s = await session.open({ kind: 'resolve', name: query, family }, { shared: true });
      s.closeWrite();
      const addresses = Array.isArray(s.info.addresses) ? s.info.addresses : [];
      return addresses.length ? { addresses, ttl: s.info.ttl ?? 30 } : [];
    },
    async dial({ host, port }) {
      const local = mine(host);
      if (local && port === 22 && !session.caps().includes('ssh')) {
        throw failure(`ECONNREFUSED: ${label()} offers no ssh`);
      }
      const meta = !local
        ? { kind: 'tcp', host: bareHost(host), port }
        : port === 22
          ? { kind: 'ssh' }
          : { kind: 'tcp', host: '127.0.0.1', port };
      const s = await session.open(meta).catch((error) => Promise.reject(mapped(error)));
      return {
        localAddr: s.info.localAddr ?? '',
        remoteAddr: s.info.remoteAddr ?? `${host}:${port}`,
        read: () => s.read(),
        write: (bytes) => s.write(bytes),
        closeWrite: () => s.closeWrite(),
        close: () => s.close(),
      };
    },
    async fetch(request) {
      const { signal } = request;
      signal?.throwIfAborted();
      const url = new URL(request.url);
      if (mine(url.hostname)) url.hostname = '127.0.0.1';
      const body = request.body
        ? new Uint8Array(await new Response(request.body).arrayBuffer())
        : new Uint8Array(0);
      const s = await session.open({ kind: 'http' });
      const cancel = async () => s.close();
      signal?.addEventListener('abort', cancel, { once: true });
      const head = encoder.encode(
        JSON.stringify({ url: url.href, method: request.method, headers: request.headers })
      );
      await s.write(u32(head.length));
      await s.write(head);
      if (body.length) await s.write(body);
      s.closeWrite();
      const reader = bufferedReader(s);
      const size = new DataView((await reader.take(4)).buffer).getUint32(0);
      const answer = json(await reader.take(size));
      if (!answer) {
        s.close();
        throw failure('EPROTO: a malformed response head');
      }
      return {
        status: answer.status,
        statusText: answer.statusText ?? '',
        headers: answer.headers ?? [],
        cancel,
        body: {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              const value = await reader.next();
              return value === null ? { value: undefined, done: true } : { value, done: false };
            },
            return: async () => {
              await cancel();
              return { value: undefined, done: true };
            },
          }),
        },
      };
    },
  };
}

export function dnsLabel(hint, taken) {
  const base =
    String(hint ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'node';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function offerLink({ pc, send, hello, timers, onClose }) {
  const control = pc.createDataChannel(CONTROL, { ordered: true });
  const session = createSession({
    control,
    createChannel: (label) => pc.createDataChannel(label, { ordered: true }),
    hello,
    timers,
    onClose: (reason) => {
      pc.close();
      onClose?.(reason);
    },
  });
  const early = [];
  const pending = [];
  let offered = false;
  let described = false;
  pc.addEventListener('datachannel', (event) => session.adopt(event.channel));
  pc.addEventListener('icecandidate', (event) => {
    const message = {
      t: 'candidate',
      candidate: event.candidate ? event.candidate.toJSON() : null,
    };
    if (offered) send(message);
    else pending.push(message);
  });
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') session.close('the connection failed');
  });
  const started = (async () => {
    await pc.setLocalDescription(await pc.createOffer());
    send({ t: 'offer', sdp: pc.localDescription.sdp });
    offered = true;
    for (const message of pending.splice(0)) send(message);
  })();
  return {
    session,
    started,
    async receive(message) {
      if (message.t === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        described = true;
        for (const candidate of early.splice(0)) await pc.addIceCandidate(candidate);
      } else if (message.t === 'candidate' && message.candidate) {
        if (described) await pc.addIceCandidate(message.candidate);
        else early.push(message.candidate);
      } else if (message.t === 'bye') {
        session.close(message.reason ?? 'the node said bye');
      }
    },
  };
}

export function createLinks({ router, makePeer, onLink = () => {}, timers, name = 'seven' }) {
  const links = new Map();
  const taken = () => new Set([...links.values()].map((link) => link.label).filter(Boolean));
  const free = (wanted) => {
    const used = new Set([...links.values()].map((link) => link.address));
    if (wanted?.startsWith(`${SUBNET}.`) && !used.has(wanted)) return wanted;
    for (let n = FIRST; n < 255; n += 1) if (!used.has(`${SUBNET}.${n}`)) return `${SUBNET}.${n}`;
    throw failure('ENOSPC: no free link address');
  };
  let local = null;
  const listeners = new Set();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const manager = {
    links,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    devices: () => [...links.values()].map(device),
    start({ key, send, mode, iceServers, address }) {
      manager.drop(key, 'replaced');
      const link = { key, mode, address: free(address), label: null, peer: null };
      const pc = makePeer({ iceServers });
      link.offer = offerLink({
        pc,
        send,
        hello: { name, mode, caps: [] },
        timers,
        onClose: () => {
          if (links.get(key) === link) links.delete(key);
          router.remove(link.exit);
          changed();
        },
      });
      link.exit = linkExit(link.offer.session, {
        id: `link:${key}`,
        address: link.address,
        label: () => link.label,
      });
      links.set(key, link);
      link.offer.session.ready.then(
        (peer) => {
          link.label = dnsLabel(peer.host ?? peer.name, taken());
          link.peer = peer;
          router.add(link.exit);
          onLink(link, peer);
          changed();
        },
        () => {}
      );
      changed();
      return link;
    },
    drop(key, reason) {
      const link = links.get(key);
      if (!link) return;
      links.delete(key);
      link.offer.session.close(reason);
    },
    receiveLocal(text, sendLocal) {
      const message = typeof text === 'string' ? JSON.parse(text) : text;
      if (message.t === 'hello') {
        const { nonce } = message;
        local = nonce;
        manager.start({
          key: 'local',
          mode: 'local',
          send: (out) => {
            if (nonce === local) sendLocal(JSON.stringify({ ...out, nonce }));
          },
        });
        return;
      }
      if (message.nonce !== local) return;
      void links.get('local')?.offer.receive(message);
    },
  };
  return manager;
}

const OFFERS = ['net', 'http', 'ssh'];

export function device(link) {
  const { peer } = link;
  const caps = Array.isArray(peer?.caps) ? peer.caps : [];
  return {
    id: link.key,
    name: String(peer?.name ?? (link.mode === 'local' ? 'slicc on this computer' : 'slicc')),
    host: link.label ? `${link.label}.slicc.internal` : '',
    address: link.address,
    mode: link.mode,
    offers: OFFERS.filter((offer) => caps.includes(offer)),
    ...(typeof peer?.policy?.summary === 'string' ? { policy: peer.policy.summary } : {}),
    exit: Boolean(peer?.routes?.exit) && caps.includes('net'),
    state: peer ? 'connected' : 'connecting',
  };
}

const KNOWN_HOSTS = [
  'd="$HOME/.ssh"; [ -d "$d" ] || mkdir -p "$d"; f="$d/known_hosts"; out=""',
  'if [ -f "$f" ]; then while IFS= read -r line || [ -n "$line" ]; do',
  'case "${line%% *}" in "$1,"*|*",$2") ;; *) out+="$line"$\'\\n\' ;; esac',
  'done < "$f"; fi',
  'printf \'%s%s,%s %s\\n\' "$out" "$1" "$2" "$3" > "$f.new" && mv -f "$f.new" "$f"',
].join('\n');

export async function trustHostKey(kernel, link, peer) {
  const key = String(peer.sshHostKey ?? '');
  if (!/^ssh-[a-z0-9-]+ [A-Za-z0-9+/]+=*$/.test(key)) return false;
  const name = `${link.label}.slicc.internal`;
  const { status } = await kernel.run([
    'bash',
    '-c',
    KNOWN_HOSTS,
    'known-hosts',
    name,
    link.address,
    key,
  ]);
  return status === 0;
}

export function installLocal(links, scope = globalThis) {
  scope.sliccLinkReceive = (text) =>
    links.receiveLocal(text, (out) => {
      if (typeof scope.sliccLinkSend === 'function') scope.sliccLinkSend(out);
    });
}
