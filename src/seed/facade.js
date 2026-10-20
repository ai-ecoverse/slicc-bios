export const LINK_PORT = 7400;
export const LINK_URL = `tcp://127.0.0.1:${LINK_PORT}`;
export const CONTROL = 1;
export const DATA = 2;
export const END = 3;
export const MAX_CONTROL = 64 * 1024;
export const MAX_RECORD = 16 * 1024 * 1024;
export const NOT_ENFORCED =
  "EACCES: this seven links to other sevens only when its kernel users are 'enforce'";
export const NOT_SUDO = 'EACCES: only root and members of sudo may reach another seven';
const NOT_AGENT =
  'EOPNOTSUPP: the link facade opens only agent prompt, watch and abort streams and tray requests';
export const NO_TRAY = 'EOPNOTSUPP: this seven has no tray';
const TRAY_OPS = ['status', 'url', 'rotate', 'unlink', 'retry'];
const DEVICE = [
  'id',
  'name',
  'kind',
  'host',
  'address',
  'mode',
  'offers',
  'policy',
  'exit',
  'state',
  'access',
];

const failure = (code, message) => Object.assign(new Error(message), { code });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strict = new TextDecoder('utf-8', { fatal: true });

export function record(type, payload = new Uint8Array(0)) {
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const out = new Uint8Array(5 + bytes.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, bytes.length);
  out.set(bytes, 5);
  return out;
}

export function reason(error) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'EIO';
  const message = typeof error?.message === 'string' ? error.message : '';
  return message && message !== code ? `${code}: ${message}` : code;
}

export function permitted(stamp, sudoGid) {
  if (stamp?.users !== 'enforce') return NOT_ENFORCED;
  if (stamp.uid === 0) return null;
  const groups = Array.isArray(stamp.groups) ? stamp.groups : [];
  return Number.isInteger(sudoGid) && groups.includes(sudoGid) ? null : NOT_SUDO;
}

const json = (bytes) => {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
};

const errno = (text) => {
  const code = text.split(':')[0].trim();
  return /^E[A-Z0-9]{1,15}$/.test(code) ? code : 'ECONNRESET';
};

const flag = (open, name) => (open[name] === true ? { [name]: true } : {});

export function outbound(open) {
  if (open?.kind !== 'agent') return null;
  if (open.op === 'abort') return { kind: 'agent', op: 'abort' };
  if (open.op === 'watch')
    return {
      kind: 'agent',
      op: 'watch',
      ...(typeof open.since === 'string' ? { since: open.since } : {}),
      ...flag(open, 'thinking'),
    };
  if (open.op !== 'prompt') return null;
  const busy = ['followUp', 'steer', 'reject'].includes(open.whenBusy) ? open.whenBusy : 'followUp';
  const body =
    typeof open.text === 'string'
      ? { text: open.text }
      : Number.isInteger(open.length) && open.length >= 0 && open.length <= MAX_RECORD
        ? { length: open.length }
        : null;
  return (
    body && { kind: 'agent', op: 'prompt', ...body, whenBusy: busy, ...flag(open, 'thinking') }
  );
}

function shown(device) {
  return Object.fromEntries(
    DEVICE.filter((key) => device?.[key] !== undefined).map((key) => [key, device[key]])
  );
}

function redacted(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('<join-url>');
  return out;
}

export const UNAPPROVED = "the owner didn't approve this";
const ASKED = ['url', 'rotate', 'unlink'];

export function trayRequests({ tray, network, hub, ask }) {
  if (!tray) return null;
  const devices = () => (network.status().links?.devices ?? []).map(shown);
  const ready = () => {
    if (tray.status().state !== 'ready' || !tray.status().joinUrl)
      throw failure('ENOTCONN', "this seven's tray isn't connected");
  };
  const device = (id) => {
    const found = devices().find((item) => item.id === id);
    if (!found) throw failure('ENOENT', 'no linked device has that id');
    return found;
  };
  const answers = {
    status() {
      const { state, error, joinUrl, joinCommand, webhookUrl, followUrl } = tray.status();
      const secrets = [joinUrl, joinCommand, webhookUrl, followUrl];
      return {
        tray: state,
        ...(error ? { error: redacted(error, secrets) } : {}),
        ...(hub ? { hub: new URL(hub).origin } : {}),
        exit: network.status().exit ?? null,
        devices: devices(),
      };
    },
    url() {
      ready();
      return { url: tray.status().joinUrl };
    },
    async rotate() {
      await network.rotateJoinUrl();
      return {};
    },
    async unlink({ id }) {
      await network.unlink(id);
      return {};
    },
    async retry() {
      await network.retryLinks();
      return {};
    },
  };
  return async (open, stamp) => {
    if (!TRAY_OPS.includes(open?.op))
      throw failure('EINVAL', 'a tray request is status, url, rotate, unlink or retry');
    if (open.op === 'unlink' && (typeof open.id !== 'string' || !open.id))
      throw failure('EINVAL', 'unlink needs the id of a linked device');
    const found = open.op === 'unlink' ? device(open.id) : undefined;
    if (open.op === 'url') ready();
    const asked = ASKED.includes(open.op) && stamp?.uid !== 0;
    if (asked && !(await ask({ op: open.op, stamp, device: found })))
      throw failure('EACCES', UNAPPROVED);
    return answers[open.op](open);
  };
}

function joined(chunks) {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function linkFacade({ check, leaders, scrub, trays = null, refused = () => {} }) {
  return (stamp) => {
    const conn = { onmessage: null, onclose: null };
    let buffer = new Uint8Array(0);
    let queue = Promise.resolve();
    let started = false;
    let finished = false;
    let join = null;
    let stream = null;
    let release = () => {};
    let long = null;
    let gotEnd = false;
    let sentEnd = false;
    let broken = false;

    const out = (type, payload) => {
      if (!finished) conn.onmessage?.(record(type, payload));
    };
    const finish = (code = 'ECONNRESET') => {
      if (finished) return;
      finished = true;
      stream?.reset(code);
      release();
      conn.onclose?.();
    };
    const reset = (why) => {
      out(CONTROL, JSON.stringify({ reset: why }));
      finish();
    };

    async function relay() {
      try {
        for (let chunk = await stream.read(); chunk; chunk = await stream.read()) out(DATA, chunk);
        sentEnd = true;
        out(END);
        if (gotEnd) finish();
      } catch (error) {
        reset(reason(error));
      }
    }

    async function reach(open, answer) {
      const linked = await leaders.open(join, open);
      if (finished) {
        linked.stream.reset('ECONNRESET');
        linked.release();
        return false;
      }
      ({ stream, release } = linked);
      if (answer) out(CONTROL, JSON.stringify({ opened: stream.info ?? {} }));
      void relay();
      return true;
    }

    async function begin(hello) {
      const refusal = await check(stamp);
      if (refusal) {
        if (stamp?.users === 'enforce') refused(stamp);
        return reset(refusal);
      }
      if (hello?.v !== 1) return reset('EPROTO');
      return hello.open?.kind === 'tray' ? request(hello) : agent(hello);
    }

    async function agent(hello) {
      if (typeof hello.join !== 'string') return reset('EPROTO');
      const open = outbound(hello.open);
      if (!open) return reset(hello.open?.kind === 'agent' ? 'EINVAL' : NOT_AGENT);
      join = hello.join;
      if (open.length !== undefined) {
        long = { open, chunks: [], total: 0 };
        return out(CONTROL, JSON.stringify({ opened: {} }));
      }
      if (open.text !== undefined) open.text = await scrub(open.text);
      await reach(open, true);
    }

    async function request(hello) {
      if (!trays) return reset(NO_TRAY);
      if ('join' in hello) return reset('EINVAL: a tray request takes no join URL');
      const result = await trays(hello.open, stamp);
      out(CONTROL, JSON.stringify({ opened: result }));
      finish();
    }

    async function upload({ open, chunks, total }) {
      if (total !== open.length) return reset('EPROTO: the prompt is shorter than its length');
      let text;
      try {
        text = strict.decode(joined(chunks));
      } catch {
        return reset("EINVAL: the prompt isn't UTF-8");
      }
      const bytes = encoder.encode(await scrub(text));
      if (!(await reach({ ...open, length: bytes.length }, false))) return;
      await stream.write(bytes);
      stream.closeWrite();
    }

    function told(payload) {
      const message = json(payload);
      if (typeof message?.reset !== 'string') return reset('EPROTO');
      finish(errno(message.reset));
    }

    function ended() {
      gotEnd = true;
      if (long) return upload(long);
      stream.closeWrite();
      if (sentEnd) finish();
    }

    function data(payload) {
      if (!long) return stream.write(payload);
      long.total += payload.length;
      if (long.total > long.open.length) return reset('EPROTO');
      long.chunks.push(payload);
    }

    async function handle(type, payload) {
      if (finished) return;
      if (!started) {
        started = true;
        return type === CONTROL ? begin(json(payload)) : reset('EPROTO');
      }
      if (type === CONTROL) return told(payload);
      if (gotEnd) return reset('EPROTO');
      return type === END ? ended() : data(payload);
    }

    conn.send = (bytes) => {
      if (finished || broken) return;
      const merged = new Uint8Array(buffer.length + bytes.length);
      merged.set(buffer);
      merged.set(bytes, buffer.length);
      buffer = merged;
      while (buffer.length >= 5) {
        const type = buffer[0];
        const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
        if (type < CONTROL || type > END || size > (type === CONTROL ? MAX_CONTROL : MAX_RECORD)) {
          broken = true;
          buffer = new Uint8Array(0);
          queue = queue.then(() => reset('EPROTO'));
          return;
        }
        if (buffer.length < 5 + size) return;
        const payload = buffer.slice(5, 5 + size);
        buffer = buffer.slice(5 + size);
        queue = queue.then(() => handle(type, payload)).catch((error) => reset(reason(error)));
      }
    };
    conn.close = () => {
      if (finished) return;
      finished = true;
      stream?.reset('ECONNRESET');
      release();
    };
    return conn;
  };
}
