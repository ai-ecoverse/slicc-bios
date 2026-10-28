export function captureLinkProtocol() {
  const records = [];
  const streams = new Map();
  const calls = new Map();
  let nextCall = 0;
  const names = new Map();
  const decoder = new TextDecoder();
  const start = performance.now();
  const capture = { active: false, capped: false, records };
  globalThis.linkProtocolCapture = capture;
  const label = (kind, value) => {
    if (typeof value !== 'string' || !value) return undefined;
    const key = `${kind}:${value}`;
    if (!names.has(key)) names.set(key, `${kind}-${names.size + 1}`);
    return names.get(key);
  };
  const remember = (record) => {
    if (!capture.active) return;
    if (records.length >= 2400) {
      capture.capped = true;
      return;
    }
    records.push({ ms: Math.round(performance.now() - start), ...record });
  };
  const methodOf = (method) =>
    typeof method === 'string' && /^[A-Za-z]+\.[A-Za-z0-9]+$/.test(method) ? method : undefined;
  const keyOf = (stream, message) => `${stream}:${message.sessionId ?? ''}:${message.id}`;
  const metadata = (stream, direction, message) => {
    const method = methodOf(message.method);
    const frame = message.params?.frame ?? message.result?.frameTree?.frame;
    const root = label('root', frame?.id ?? message.params?.frameId);
    const loader = label('loader', frame?.loaderId ?? message.params?.loaderId);
    const target = label(
      'target',
      message.params?.targetId ?? message.params?.targetInfo?.targetId
    );
    const session = label(
      'session',
      message.sessionId ?? message.params?.sessionId ?? message.result?.sessionId
    );
    if (direction === 'out' && method && Number.isInteger(message.id) && message.id >= 2 ** 30) {
      const call = `call-${++nextCall}`;
      calls.set(keyOf(stream, message), { method, call });
      remember({
        phase: 'call',
        method,
        call,
        target,
        session,
        root,
        loader,
        blank:
          method === 'Page.navigate' &&
          message.params?.url === 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E',
      });
    } else if (direction === 'in' && Number.isInteger(message.id)) {
      const request = calls.get(keyOf(stream, message));
      if (!request) return;
      calls.delete(keyOf(stream, message));
      const code = message.error?.code;
      remember({
        phase: 'answer',
        ...request,
        ok: !message.error,
        code: typeof code === 'number' && Number.isFinite(code) ? code : undefined,
        session,
        root,
        loader,
        main: frame ? !frame.parentId : undefined,
        errorDocument: frame ? frame.url?.startsWith('chrome-error:') === true : undefined,
      });
    } else if (
      direction === 'in' &&
      method &&
      /^(?:Target\.(?:targetCreated|targetInfoChanged|targetDestroyed|attachedToTarget|detachedFromTarget)|Page\.(?:frameNavigated|frameStartedNavigating|frameStartedLoading|frameStoppedLoading|frameDetached)|Network\.loadingFailed)$/.test(
        method
      )
    ) {
      remember({
        phase: 'event',
        method,
        target,
        session,
        root,
        loader,
        main: frame ? !frame.parentId : undefined,
        errorDocument: frame ? frame.url?.startsWith('chrome-error:') === true : undefined,
      });
    }
  };
  const consume = (channel, direction, data) => {
    if (typeof data === 'string') return;
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    if (bytes.length < 5) return;
    const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
    const type = bytes[0];
    const streamKey = `${channel}:${id}`;
    if (direction === 'out' && type === 1) {
      const meta = JSON.parse(decoder.decode(bytes.subarray(5)));
      if (meta.kind === 'cdp')
        streams.set(streamKey, { in: new Uint8Array(), out: new Uint8Array() });
      return;
    }
    const stream = streams.get(streamKey);
    if (!stream || type !== 3 || stream[direction] === null) return;
    const old = stream[direction];
    if (old.length + bytes.length - 5 > 16 * 1024 * 1024) {
      capture.capped = true;
      stream[direction] = null;
      return;
    }
    const merged = new Uint8Array(old.length + bytes.length - 5);
    merged.set(old);
    merged.set(bytes.subarray(5), old.length);
    let offset = 0;
    while (merged.length - offset >= 4) {
      const length = new DataView(merged.buffer, offset).getUint32(0);
      if (length > 16 * 1024 * 1024) {
        capture.capped = true;
        stream[direction] = null;
        return;
      }
      if (merged.length - offset < length + 4) break;
      const message = JSON.parse(decoder.decode(merged.subarray(offset + 4, offset + length + 4)));
      metadata(streamKey, direction, message);
      offset += length + 4;
    }
    stream[direction] = merged.slice(offset);
  };
  const channels = new WeakMap();
  let nextChannel = 0;
  const observe = (channel) => {
    if (channels.has(channel)) return;
    const id = ++nextChannel;
    channels.set(channel, id);
    channel.addEventListener('message', ({ data }) => {
      try {
        consume(id, 'in', data);
      } catch {
        capture.capped = true;
      }
    });
  };
  const Peer = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class extends Peer {
    constructor(...args) {
      super(...args);
      this.addEventListener('datachannel', ({ channel }) => observe(channel));
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      observe(channel);
      return channel;
    }
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    observe(this);
    try {
      consume(channels.get(this), 'out', data);
    } catch {
      capture.capped = true;
    }
    return send.call(this, data);
  };
}
