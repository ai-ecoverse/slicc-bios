import { sevenHost } from './seven-host.js';

export const HOST_KEY = 'slicc-os.serve-host';
export const HUB_KEY = 'slicc-os.serve-hub';
export const PROTOCOL = 'slicc-serve.v1';
export const PING_MS = 30_000;
export const OPEN_MS = 15_000;
export const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
export const REPLACED = 4000;
export const DELETED = 4001;
export const NOT_CONNECTED = 'seven isn’t connected to the serve hub yet; try again in a moment';
export const TAKEN = 'another tab of seven took over its serve host';

const HOST = /^[0-9a-f]{20}$/;
const SECRET = /^[0-9a-f]{64}$/;

export function serveHubBase({ protocol, hostname, home, storage }) {
  if (sevenHost({ protocol, hostname })) return home;
  const stored = storage.getItem(HUB_KEY);
  return stored ? stored.replace(/\/+$/, '') : null;
}

export function storedHost(storage) {
  try {
    const value = JSON.parse(storage.getItem(HOST_KEY));
    return HOST.test(value?.hostId) && SECRET.test(value?.secret)
      ? { hostId: value.hostId, secret: value.secret }
      : null;
  } catch {
    return null;
  }
}

async function answered(response) {
  const value = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    value: value && typeof value === 'object' ? value : {},
    headers: response.headers,
  };
}

const gone = ({ status, value }) =>
  (status === 404 && value.code === 'HOST_NOT_FOUND') ||
  (status === 410 && value.code === 'HOST_GONE');

const failure = (answer, what) =>
  new Error(
    typeof answer.value.error === 'string' && answer.value.error
      ? answer.value.error
      : `the serve hub answered ${answer.status} ${what}`
  );

export const encodedPath = (path) => path.split('/').map(encodeURIComponent).join('/');

export function createServeHub({
  base,
  fetch: fetcher,
  WebSocket: Socket,
  storage,
  timers = globalThis,
  on = {},
  ms = OPEN_MS,
}) {
  let host = storedHost(storage);
  let creating = null;
  let socket = null;
  let ready = false;
  let wanted = false;
  let retry = null;
  let ping = null;
  let attempts = 0;
  let waiters = [];

  function create() {
    creating ??= (async () => {
      const made = await answered(await fetcher(`${base}/api/serve/host`, { method: 'POST' }));
      const { hostId, secret } = made.value;
      if (made.status !== 201 || !HOST.test(hostId) || !SECRET.test(secret))
        throw failure(made, 'for a new host');
      host = { hostId, secret };
      storage.setItem(HOST_KEY, JSON.stringify(host));
      return host;
    })().finally(() => {
      creating = null;
    });
    return creating;
  }

  function forget(current) {
    if (host !== current) return;
    host = null;
    storage.removeItem(HOST_KEY);
    const old = socket;
    socket = null;
    if (old) closed({});
    old?.close();
  }

  async function call(method, tail, { json, body, type } = {}) {
    for (let tries = 0; ; tries += 1) {
      const current = host ?? (await create());
      const headers = { authorization: `Bearer ${current.secret}` };
      if (json !== undefined) headers['content-type'] = 'application/json';
      if (type) headers['content-type'] = type;
      const answer = await answered(
        await fetcher(`${base}/api/serve/host/${current.hostId}${tail}`, {
          method,
          headers,
          ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
          ...(body !== undefined ? { body } : {}),
        })
      );
      if (!gone(answer) || tries > 0) return answer;
      forget(current);
    }
  }

  function settle(error) {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      timers.clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  function schedule() {
    timers.clearTimeout(retry);
    if (!wanted) return;
    const delay = RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)];
    attempts += 1;
    retry = timers.setTimeout(() => {
      retry = null;
      void open();
    }, delay);
  }

  function closed({ code }) {
    timers.clearInterval(ping);
    const wasReady = ready;
    ready = false;
    on.closed?.();
    if (code === REPLACED) {
      wanted = false;
      settle(new Error(TAKEN));
      on.replaced?.();
      return;
    }
    if (code === DELETED) {
      forget(host);
      on.deleted?.();
    }
    if (!wasReady && waiters.length)
      void probe().then((error) => {
        if (error) settle(error);
      });
    schedule();
  }

  async function probe() {
    try {
      const answer = await call('GET', '/previews');
      return answer.ok ? null : failure(answer, 'for its previews');
    } catch (error) {
      return error;
    }
  }

  function message(event) {
    if (typeof event.data !== 'string') return on.binary?.(event.data);
    if (event.data === 'pong') return;
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (parsed?.type === 'hello') {
      ready = true;
      attempts = 0;
      timers.clearInterval(ping);
      ping = timers.setInterval(() => socket?.send('ping'), PING_MS);
      settle(null);
    }
    on.message?.(parsed);
  }

  async function open() {
    if (socket || !wanted) return;
    let current;
    try {
      current = host ?? (await create());
    } catch (error) {
      settle(error);
      return schedule();
    }
    if (socket || !wanted) return;
    const url = `${base.replace(/^http/, 'ws')}/api/serve/host/${current.hostId}/ws`;
    const next = new Socket(url, [PROTOCOL, `bearer.${current.secret}`]);
    next.binaryType = 'arraybuffer';
    socket = next;
    next.addEventListener('message', (event) => {
      if (next === socket) message(event);
    });
    next.addEventListener('close', (event) => {
      if (next !== socket) return;
      socket = null;
      closed(event);
    });
  }

  return {
    hostId: () => host?.hostId ?? null,
    ready: () => ready,
    connect() {
      wanted = true;
      if (ready) return Promise.resolve();
      const waiting = new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiter.timer = timers.setTimeout(() => {
          waiters = waiters.filter((item) => item !== waiter);
          reject(new Error(NOT_CONNECTED));
        }, ms);
        waiters.push(waiter);
      });
      timers.clearTimeout(retry);
      retry = null;
      void open();
      return waiting;
    },
    send(value) {
      if (!ready || socket?.readyState !== 1) return false;
      socket.send(value instanceof Uint8Array ? value : JSON.stringify(value));
      return true;
    },
    mint: (body) => call('POST', '/previews', { json: body }),
    list: () => call('GET', '/previews'),
    stop: (token) => call('DELETE', `/previews/${encodeURIComponent(token)}`),
    file: ({ previewToken, path, type, bytes }) =>
      call('PUT', `/previews/${encodeURIComponent(previewToken)}/files/${encodedPath(path)}`, {
        type,
        body: bytes,
      }),
    finalize: (token) => call('POST', `/previews/${encodeURIComponent(token)}/finalize`),
  };
}
