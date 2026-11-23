export const WINDOW = 1024 * 1024;
export const FRAME = 64 * 1024;
export const HEAD_BYTES = 64 * 1024;
export const MAX_HEADERS = 256;
export const GONE = 'this preview is no longer served';
export const FETCH_MS = 25_000;
export const LIMITS = {
  headMs: FETCH_MS,
  idleMs: FETCH_MS,
  perPreview: 16,
  streams: 64,
};

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const VALUE = /^[^\r\n\0]*$/;
const PATH = /^\/[!-~\u0080-\uffff]*$/;
const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

const HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

export function hopless(headers, extra = []) {
  const listed = headers
    .filter(([name]) => name.toLowerCase() === 'connection')
    .flatMap(([, value]) => value.split(','))
    .map((name) => name.trim().toLowerCase());
  const dropped = new Set([...HOP, ...listed, ...extra]);
  return headers.filter(([name]) => !dropped.has(name.toLowerCase()));
}

export function frame(id, bytes) {
  const out = new Uint8Array(bytes.byteLength + 4);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out;
}

export function unframe(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 5) return null;
  const id = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  return { id, bytes: bytes.subarray(4) };
}

export function pairs(value) {
  if (!Array.isArray(value)) return null;
  const ok = value.every(
    (pair) =>
      Array.isArray(pair) &&
      typeof pair[0] === 'string' &&
      typeof pair[1] === 'string' &&
      TOKEN.test(pair[0]) &&
      VALUE.test(pair[1])
  );
  return ok ? value.map(([name, value]) => [name.toLowerCase(), value]) : null;
}

export function requestHead({ method, path, host, headers, port, length = null, chunked }) {
  const kept = hopless(headers, ['host', 'expect', 'content-length']).filter(
    ([name]) => !name.startsWith('x-forwarded-')
  );
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    ...kept.map(([name, value]) => `${name}: ${value}`),
    ...(length !== null ? [`Content-Length: ${length}`] : []),
    ...(chunked ? ['Transfer-Encoding: chunked'] : []),
    ...(host ? [`X-Forwarded-Host: ${host}`] : []),
    'X-Forwarded-Proto: https',
    'Connection: close',
    '',
    '',
  ];
  return encoder.encode(lines.join('\r\n'));
}

export function onOrigin(location, port) {
  if (!URL.canParse(location)) return location;
  const target = new URL(location);
  const own = [`127.0.0.1:${port}`, `localhost:${port}`, `${port}.kernel.localhost`];
  if (target.protocol !== 'http:' || !own.includes(target.host)) return location;
  return `${target.pathname}${target.search}${target.hash}`;
}

export function parseHead(bytes) {
  const [status = '', ...lines] = latin1.decode(bytes).split('\r\n');
  const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(status);
  if (!match) throw new Error(`not an HTTP/1.x answer: ${status.slice(0, 80)}`);
  const headers = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  if (headers.length > MAX_HEADERS) throw new Error(`more than ${MAX_HEADERS} headers`);
  return { status: Number(match[1]), headers };
}

export class Source {
  constructor(reader) {
    this.reader = reader;
    this.held = new Uint8Array(0);
    this.done = false;
  }

  async more() {
    if (this.done) return false;
    const { value, done } = await this.reader.read();
    if (done) {
      this.done = true;
      return false;
    }
    const joined = new Uint8Array(this.held.byteLength + value.byteLength);
    joined.set(this.held);
    joined.set(value, this.held.byteLength);
    this.held = joined;
    return true;
  }

  take(count) {
    const out = this.held.slice(0, count);
    this.held = this.held.slice(count);
    return out;
  }

  async until(separator, limit) {
    const mark = encoder.encode(separator);
    for (;;) {
      const at = indexOf(this.held, mark);
      if (at >= 0) {
        const out = this.take(at);
        this.take(mark.byteLength);
        return out;
      }
      if (this.held.byteLength > limit) throw new Error(`a line over ${limit} bytes`);
      if (!(await this.more())) return null;
    }
  }

  async exactly(count) {
    while (this.held.byteLength < count) if (!(await this.more())) return null;
    return this.take(count);
  }

  async some(max) {
    if (!this.held.byteLength && !(await this.more())) return null;
    return this.take(max);
  }
}

function indexOf(bytes, mark) {
  outer: for (let at = 0; at <= bytes.byteLength - mark.byteLength; at += 1) {
    for (let k = 0; k < mark.byteLength; k += 1) if (bytes[at + k] !== mark[k]) continue outer;
    return at;
  }
  return -1;
}

async function* pieces(source, count) {
  for (let left = count; left > 0; ) {
    const piece = await source.some(Math.min(left, FRAME));
    if (!piece) throw new Error('the server closed the connection before the end of its body');
    left -= piece.byteLength;
    yield piece;
  }
}

async function* chunks(source) {
  for (;;) {
    const line = await source.until('\r\n', 4096);
    if (!line) throw new Error('the chunked body ended early');
    const size = Number.parseInt(latin1.decode(line).split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('a malformed chunk size');
    if (size === 0) return;
    yield* pieces(source, size);
    if (!(await source.exactly(2))) throw new Error('a chunk ended early');
  }
}

async function* rest(source) {
  for (;;) {
    const piece = await source.some(FRAME);
    if (!piece) return;
    yield piece;
  }
}

export function bodyOf(source, { status, headers }, method) {
  if (method === 'HEAD' || status === 204 || status === 304) return null;
  const named = (key) => headers.find(([name]) => name === key)?.[1];
  if (/chunked/i.test(named('transfer-encoding') ?? '')) return chunks(source);
  const length = named('content-length');
  if (length !== undefined) {
    const count = Number(length);
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(count))
      throw new Error(`a bad Content-Length: ${length.slice(0, 40)}`);
    return pieces(source, count);
  }
  return rest(source);
}

export function answerHeaders(head, port) {
  const chunked = /chunked/i.test(
    head.headers.find(([name]) => name === 'transfer-encoding')?.[1] ?? ''
  );
  return hopless(head.headers, chunked ? ['content-length'] : []).map(([name, value]) =>
    name === 'location' ? [name, onOrigin(value, port)] : [name, value]
  );
}

const seconds = (ms) => `${ms / 1000} s`;

function plain(status, text, extra = []) {
  return { status, headers: [['content-type', 'text/plain; charset=utf-8'], ...extra], text };
}

const hostOf = (url) => (URL.canParse(url) ? new URL(url).host : null);

function lengthOf(headers) {
  const value = headers.find(([name]) => name === 'content-length')?.[1];
  if (value === undefined) return null;
  return /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
}

function streamOps({ streams, send, timers, limits }) {
  const finish = (stream) => {
    if (streams.get(stream.id) !== stream) return;
    streams.delete(stream.id);
    timers.clearTimeout(stream.timer);
    stream.credit?.();
    try {
      stream.socket?.close();
    } catch {}
  };

  const cancel = (stream, reason) => {
    if (streams.get(stream.id) !== stream) return;
    send({ type: 'http.cancel', id: stream.id, reason });
    finish(stream);
  };

  const live = (stream) => streams.get(stream.id) === stream;

  function expire(stream, reason) {
    if (!live(stream)) return;
    stream.ended = true;
    try {
      stream.socket?.close();
    } catch {}
    if (stream.answered) return cancel(stream, reason);
    void respond(stream, plain(504, reason));
  }

  const arm = (stream, ms, reason) => {
    timers.clearTimeout(stream.timer);
    stream.timer = timers.setTimeout(() => expire(stream, reason), ms);
  };
  const progress = (stream) =>
    arm(
      stream,
      limits.idleMs,
      `kernel port ${stream.port} sent nothing for ${seconds(limits.idleMs)}`
    );

  async function window(stream, size) {
    while (live(stream) && stream.sent - stream.acked + size > WINDOW)
      await new Promise((resolve) => {
        stream.credit = resolve;
      });
    return live(stream);
  }

  async function pump(stream, pieces, counted) {
    for await (const piece of pieces) {
      if (!live(stream)) return false;
      if (counted) progress(stream);
      for (let at = 0; at < piece.byteLength; at += FRAME) {
        const part = piece.subarray(at, at + FRAME);
        if (!(await window(stream, part.byteLength))) return false;
        send(frame(stream.id, part));
        stream.sent += part.byteLength;
      }
    }
    return live(stream);
  }

  async function respond(stream, { status, headers, body, text }) {
    if (stream.answered || !live(stream)) return;
    const bytes = text === undefined ? null : encoder.encode(text);
    const flowing = body !== null || bytes !== null;
    send({ type: 'http.response', id: stream.id, status, headers, body: flowing });
    stream.answered = true;
    if (!flowing) return finish(stream);
    if (!(await pump(stream, bytes ? [bytes] : body, !bytes))) return;
    send({ type: 'http.response.end', id: stream.id });
    finish(stream);
  }

  return { finish, cancel, live, expire, arm, progress, respond };
}

export function requested(message) {
  const headers = pairs(message.headers);
  const method = typeof message.method === 'string' ? message.method : '';
  const path = typeof message.path === 'string' ? message.path : '';
  const length = headers ? lengthOf(headers) : null;
  if (!headers || !TOKEN.test(method) || !PATH.test(path) || Number.isNaN(length))
    return { refused: plain(400, 'seven refused a malformed request') };
  if (method === 'CONNECT' || method === 'TRACE')
    return { refused: plain(405, `seven doesn't relay ${method}`) };
  const body = message.body === true;
  return {
    method,
    path,
    headers,
    length: body ? length : null,
    chunked: body && length === null,
  };
}

export function httpRelay({ dial, send, origin, timers = globalThis, limits = LIMITS }) {
  const streams = new Map();
  const { finish, cancel, live, arm, progress, respond } = streamOps({
    streams,
    send,
    timers,
    limits,
  });

  async function run(stream, request, target) {
    stream.port = target.port;
    arm(
      stream,
      limits.headMs,
      `kernel port ${target.port} didn't answer within ${seconds(limits.headMs)}`
    );
    try {
      stream.socket = await dial(target);
    } catch (error) {
      return respond(
        stream,
        plain(502, `nothing answers on kernel port ${target.port}: ${error.message}`)
      );
    }
    if (!live(stream) || stream.ended) return stream.socket.close();
    stream.writer = stream.socket.writable.getWriter();
    stream.opened(stream.writer.write(requestHead({ ...request, port: target.port })));
    const source = new Source(stream.socket.readable.getReader());
    let head;
    do {
      const raw = await source.until('\r\n\r\n', HEAD_BYTES);
      if (!raw) throw new Error('the server closed the connection before it answered');
      head = parseHead(raw);
    } while (head.status >= 100 && head.status < 200);
    if (!live(stream) || stream.ended) return;
    progress(stream);
    const body = bodyOf(source, head, request.method);
    await respond(stream, { status: head.status, headers: answerHeaders(head, target.port), body });
  }

  function queue(stream, step) {
    stream.queue = stream.queue.then(step);
    stream.queue.catch(() => undefined);
  }

  function write(stream, bytes) {
    const kept = stream.left === null ? bytes : bytes.subarray(0, stream.left);
    if (stream.left !== null) stream.left -= kept.byteLength;
    const wrapped = stream.chunked
      ? [encoder.encode(`${kept.byteLength.toString(16)}\r\n`), kept, encoder.encode('\r\n')]
      : [kept];
    queue(stream, async () => {
      for (const part of wrapped) if (part.byteLength) await stream.writer.write(part);
      send({ type: 'http.ack', id: stream.id, bytes: bytes.byteLength });
    });
  }

  return {
    request(message) {
      const id = message?.id;
      if (!Number.isInteger(id) || id < 0 || streams.has(id)) return;
      const token = message.previewToken;
      const held = [...streams.values()].filter((item) => item.token === token).length;
      const busy = streams.size >= limits.streams || held >= limits.perPreview;
      const stream = { id, token, sent: 0, acked: 0, answered: false, credit: null, left: null };
      stream.queue = new Promise((resolve) => {
        stream.opened = resolve;
      });
      streams.set(id, stream);
      const request = requested(message);
      if (request.refused) return void respond(stream, request.refused);
      const entry = origin(token);
      if (!entry) return void respond(stream, plain(404, GONE));
      const target = { port: entry.port };
      if (busy)
        return void respond(
          stream,
          plain(503, 'seven is answering too many requests for this preview', [
            ['retry-after', '1'],
          ])
        );
      stream.left = request.length;
      stream.chunked = request.chunked;
      request.host = hostOf(entry.url);
      run(stream, request, target).catch((error) => {
        if (stream.ended) return;
        if (!stream.answered) return respond(stream, plain(502, error.message));
        cancel(stream, error.message);
      });
    },
    body(data) {
      const framed = unframe(data);
      const stream = framed && streams.get(framed.id);
      if (stream) write(stream, framed.bytes);
    },
    end(message) {
      const stream = streams.get(message?.id);
      if (!stream) return;
      if (stream.chunked) queue(stream, () => stream.writer.write(encoder.encode('0\r\n\r\n')));
    },
    ack(message) {
      const stream = streams.get(message?.id);
      if (!stream || !Number.isInteger(message.bytes) || message.bytes < 0) return;
      stream.acked += message.bytes;
      if (stream.answered) progress(stream);
      stream.credit?.();
    },
    cancel(message) {
      const stream = streams.get(message?.id);
      if (stream) finish(stream);
    },
    drop(token) {
      for (const stream of [...streams.values()]) if (stream.token === token) cancel(stream, GONE);
    },
    closeAll() {
      for (const stream of [...streams.values()]) finish(stream);
    },
    open: () => streams.size,
  };
}
