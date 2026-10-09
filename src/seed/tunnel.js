const OPEN = 1;
const OPENED = 2;
const DATA = 3;
const END = 4;
const RESET = 5;
const CREDIT = 6;
const WINDOW = 256 * 1024;
const CHUNK = 65536;
const DELAYS = [1000, 2000, 5000, 10000, 30000];
const encoder = new TextEncoder();

function frame(type, id, payload = new Uint8Array(0)) {
  const bytes = new Uint8Array(5 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, type);
  view.setUint32(1, id);
  bytes.set(payload, 5);
  return bytes;
}

function number(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

class Tunnel {
  constructor(kernel, socket, closed) {
    this.kernel = kernel;
    this.socket = socket;
    this.streams = new Map();
    socket.binaryType = 'arraybuffer';
    socket.onmessage = ({ data }) => this.receive(data);
    socket.onclose = () => {
      for (const id of [...this.streams.keys()]) this.drop(id);
      closed(this);
    };
  }

  send(type, id, payload) {
    if (this.socket.readyState === 1) this.socket.send(frame(type, id, payload));
  }

  receive(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 5) return;
    const view = new DataView(data);
    const type = view.getUint8(0);
    const id = view.getUint32(1);
    const payload = new Uint8Array(data, 5);
    const stream = this.streams.get(id);
    if (type === OPEN && payload.byteLength === 2) void this.open(id, view.getUint16(5));
    else if (!stream) return;
    else if (type === DATA) this.write(id, stream, payload.slice());
    else if (type === END) {
      stream.writes = stream.writes
        .then(() => stream.writer.close())
        .then(() => this.ended(id, stream, 'theirs'))
        .catch((error) => this.reset(id, error));
    } else if (type === RESET) this.drop(id);
    else if (type === CREDIT && payload.byteLength === 4) {
      stream.outstanding -= view.getUint32(5);
      stream.wake?.();
    }
  }

  async open(id, port) {
    const stream = { outstanding: 0, writes: Promise.resolve(), ends: new Set() };
    this.streams.set(id, stream);
    try {
      stream.socket = await this.kernel.dial({ port });
    } catch (error) {
      if (this.streams.delete(id))
        this.send(RESET, id, encoder.encode(error.code ?? error.message));
      return;
    }
    if (this.streams.get(id) !== stream) {
      stream.socket.close();
      return;
    }
    stream.writer = stream.socket.writable.getWriter();
    this.send(OPENED, id);
    void this.pump(id, stream);
  }

  write(id, stream, payload) {
    stream.writes = stream.writes
      .then(() => stream.writer.write(payload))
      .then(() => this.send(CREDIT, id, number(payload.byteLength)))
      .catch((error) => this.reset(id, error));
  }

  async pump(id, stream) {
    const reader = stream.socket.readable.getReader();
    stream.reader = reader;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let at = 0; at < value.byteLength; at += CHUNK) {
          const piece = value.subarray(at, at + CHUNK);
          while (stream.outstanding + piece.byteLength > WINDOW) {
            await new Promise((resolve) => {
              stream.wake = resolve;
            });
            if (this.streams.get(id) !== stream) return;
          }
          if (this.streams.get(id) !== stream) return;
          stream.outstanding += piece.byteLength;
          this.send(DATA, id, piece);
        }
      }
      if (this.streams.get(id) === stream) {
        this.send(END, id);
        this.ended(id, stream, 'ours');
      }
    } catch (error) {
      this.reset(id, error);
    }
  }

  ended(id, stream, side) {
    stream.ends.add(side);
    if (stream.ends.size === 2 && this.streams.get(id) === stream) this.drop(id);
  }

  reset(id, error) {
    if (!this.streams.has(id)) return;
    this.send(RESET, id, encoder.encode(error?.code ?? error?.message ?? 'EIO'));
    this.drop(id);
  }

  drop(id) {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    stream.wake?.();
    stream.reader?.cancel().catch(() => {});
    stream.socket?.close();
    if (this.streams.size === 0) this.idle?.();
  }

  close() {
    this.socket.close();
  }
}

export function openTunnel(kernel, { url, key }, options = {}) {
  const {
    WebSocket = globalThis.WebSocket,
    target = globalThis,
    delays = DELAYS,
    setTimeout = globalThis.setTimeout,
    channel = globalThis.BroadcastChannel && new BroadcastChannel('slicc-kernel-tunnel'),
    hasFocus = () => globalThis.document?.hasFocus() ?? false,
  } = options;
  const address = `${url.replace(/^http:/, 'ws:')}/api/kernel-tunnel`;
  const tunnels = new Set();
  let current = null;
  let failures = 0;
  let timer;
  let stopped = false;

  function retire(tunnel) {
    if (tunnel.streams.size === 0) tunnel.close();
    else tunnel.idle = () => tunnel.close();
  }

  function connect() {
    clearTimeout(timer);
    const socket = new WebSocket(address, ['slicc.kernel-tunnel.v1', `slicc.key.${key}`]);
    const tunnel = new Tunnel(kernel, socket, (closed) => {
      tunnels.delete(closed);
      if (closed !== current || stopped) return;
      current = null;
      const delay = delays[Math.min(failures, delays.length - 1)];
      failures += 1;
      timer = setTimeout(connect, delay);
    });
    socket.onopen = () => {
      failures = 0;
      for (const other of tunnels) if (other !== tunnel) retire(other);
      channel?.postMessage('opened');
    };
    tunnels.add(tunnel);
    current = tunnel;
  }

  const claim = () => {
    if (current?.socket.readyState === 1) connect();
  };
  if (channel) {
    channel.onmessage = () => {
      if (hasFocus()) claim();
    };
  }
  target.addEventListener?.('focus', claim);
  connect();
  return {
    get tunnel() {
      return current;
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      target.removeEventListener?.('focus', claim);
      channel?.close();
      for (const tunnel of tunnels) tunnel.close();
    },
  };
}
