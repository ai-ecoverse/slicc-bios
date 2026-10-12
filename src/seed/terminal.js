import { failure } from './link.js';

export const BYTES = 0;
export const RESIZE = 1;
export const SIGNAL = 2;
export const EXIT = 3;
export const MAX_RECORD = 1024 * 1024;
export const SIZE = 10_000;
export const SIGNALS = ['INT', 'TSTP', 'QUIT', 'HUP'];
export const SHELL = ['bash', '-i'];
export const ENV = {
  PS1: 'slicc:\\w\\$ ',
  PROMPT_COMMAND: `printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-}" "$PWD"`,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function record(type, payload = new Uint8Array(0)) {
  const body = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const out = new Uint8Array(5 + body.length);
  new DataView(out.buffer).setUint32(0, body.length + 1);
  out[4] = type;
  out.set(body, 5);
  return out;
}

export function records() {
  let buffer = new Uint8Array(0);
  return (chunk) => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    const out = [];
    while (buffer.length >= 4) {
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
      if (length < 1 || length > MAX_RECORD) throw failure('EPROTO: a malformed terminal record');
      if (buffer.length < 4 + length) break;
      out.push({ type: buffer[4], payload: buffer.slice(5, 4 + length) });
      buffer = buffer.subarray(4 + length);
    }
    return out;
  };
}

const sized = (n) => Number.isInteger(n) && n >= 1 && n <= SIZE;

function resize(payload) {
  try {
    const { cols, rows } = JSON.parse(decoder.decode(payload));
    return sized(cols) && sized(rows) ? { cols, rows } : null;
  } catch {
    return null;
  }
}

function writer(stream) {
  let writes = Promise.resolve();
  const send = (bytes) => {
    writes = writes.then(() => stream.write(bytes)).catch(() => undefined);
  };
  send.flushed = () => writes;
  return send;
}

function apply(terminal, { type, payload }) {
  if (type === BYTES) return terminal.write(payload);
  if (type === RESIZE) {
    const size = resize(payload);
    if (!size) throw failure('EINVAL: a bad terminal size');
    return terminal.resize(size.cols, size.rows);
  }
  const name = type === SIGNAL ? decoder.decode(payload) : null;
  if (!SIGNALS.includes(name)) throw failure('EPROTO: a bad terminal record');
  return terminal.signal(`SIG${name}`);
}

export async function serveTerminal(kernel, meta, stream) {
  const { cols, rows, cwd } = meta;
  if (!sized(cols) || !sized(rows) || (cwd !== undefined && typeof cwd !== 'string')) {
    throw failure('EINVAL: a terminal needs cols and rows');
  }
  const send = writer(stream);
  const terminal = await kernel.openTerminal(SHELL, {
    ...(cwd ? { cwd } : {}),
    env: ENV,
    cols,
    rows,
    onData: (bytes) => send(record(BYTES, bytes)),
  });
  stream.accepted({ pid: terminal.pid ?? null });
  const parse = records();
  const exited = terminal.exited.then(
    async (status) => {
      send(record(EXIT, String(Number.isInteger(status) ? status : 0)));
      await send.flushed();
      stream.closeWrite();
    },
    () => stream.reset('EIO: the shell failed')
  );
  try {
    for (let chunk = await stream.read(); chunk; chunk = await stream.read()) {
      for (const item of parse(chunk)) apply(terminal, item);
    }
    terminal.close();
  } catch (error) {
    terminal.close();
    if (error.code) stream.reset(`${error.code}: ${error.message}`);
  }
  await exited;
}

export async function remoteTerminal(open, { cwd, cols, rows, onData }) {
  const stream = await open({ kind: 'terminal', cols, rows, ...(cwd ? { cwd } : {}) });
  const send = writer(stream);
  const parse = records();
  const exited = (async () => {
    let status = 0;
    try {
      for (let chunk = await stream.read(); chunk; chunk = await stream.read()) {
        for (const { type, payload } of parse(chunk)) {
          if (type === BYTES) onData?.(payload);
          else if (type === EXIT) status = Number.parseInt(decoder.decode(payload), 10) || 0;
        }
      }
      stream.closeWrite();
      return status;
    } catch (error) {
      onData?.(encoder.encode(`\r\n[${error.message}]\r\n`));
      return 1;
    }
  })();
  return {
    pid: stream.info?.pid ?? null,
    exited,
    write: (data) => send(record(BYTES, data)),
    resize: (c, r) => send(record(RESIZE, JSON.stringify({ cols: c, rows: r }))),
    signal: (name) => send(record(SIGNAL, String(name).replace(/^SIG/, ''))),
    close: () => stream.closeWrite(),
  };
}
