import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { stored } from './transport.js';

const CONFIG = 'tailscale';
const STATE = 'tailscale-state';
const SOURCES = ['/mnt/tailscale', '/opt/tailscale'];
const IDLE_MS = 30000;
const HEAD_MS = 60000;
const LOOPBACK = new Set(['localhost', '::1']);

export function takeTailscale(location, history) {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('tailscale')) return null;
  const value = params.get('tailscale');
  const exit = params.get('exit');
  params.delete('tailscale');
  params.delete('exit');
  const rest = params.toString();
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`
  );
  if (value === 'off') return { enabled: false };
  if (value.startsWith('tskey-'))
    console.warn('tailscale: an auth key in the address was dropped; paste it in the status bar');
  return { enabled: true, ...(exit !== null ? { exitNode: exit } : {}) };
}

export function takeSessionKey(scope = globalThis) {
  const key = scope.sliccTailscaleAuthKey;
  delete scope.sliccTailscaleAuthKey;
  return typeof key === 'string' && key.startsWith('tskey-') ? key : null;
}

export async function tailscaleConfig({
  store = stored,
  place = globalThis.location,
  past = globalThis.history,
  scope = globalThis,
} = {}) {
  const given = takeTailscale(place, past);
  const { authKey, ...saved } = (await store('readonly', (s) => s.get(CONFIG))) ?? {};
  const config = given ? { ...saved, ...given } : saved;
  if (given || authKey) await store('readwrite', (s) => s.put(config, CONFIG));
  if (!config.enabled) return null;
  const key = takeSessionKey(scope);
  return key ? { ...config, authKey: key } : config;
}

export function tailnetAddress(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(bare);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) < 128;
  return bare.startsWith('fd7a:115c:a1e0:');
}

export function viaTailnet(url, status) {
  if (status?.state !== 'Running') return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK.has(host) || host.startsWith('127.')) return false;
  if (status.exitNode) return true;
  if (tailnetAddress(host)) return true;
  const suffix = status.magicDNSSuffix?.replace(/\.$/, '').toLowerCase();
  if (suffix && host.endsWith(`.${suffix}`)) return true;
  return status.peers.some((peer) => peer.dnsName.toLowerCase().split('.')[0] === host);
}

export function describeTailscale({ backend, status, login, failed }) {
  if (failed) return { state: 'failed', text: `tailscale: ${failed}` };
  if (login || backend === 'NeedsLogin')
    return { state: 'login', text: 'tailscale: sign in or paste an auth key', login };
  if (backend !== 'Running' || !status)
    return { state: 'starting', text: `tailscale: ${backend ?? 'starting'}…` };
  const self = status.self?.addresses?.[0] ?? '';
  const exit = status.exitNode;
  const via = exit
    ? `everything via exit node ${exit.dnsName.split('.')[0] || exit.name}`
    : status.autoExitNode
      ? 'tailnet only, waiting for an exit node'
      : 'tailnet only, no exit node';
  const shields = status.shieldsUp ? '' : ', shields down';
  return { state: 'ok', text: `tailscale: ${self} (${via}${shields})` };
}

export function showTailscale(notice, view) {
  const [output, link, form] = notice.children;
  notice.dataset.state = view.state;
  output.value = view.text;
  notice.title = view.text;
  link.hidden = !view.login;
  if (view.login) link.href = view.login;
  form.hidden = view.state !== 'login';
  notice.hidden = false;
}

export function offerKey(notice, tailnet) {
  const form = notice.children[2];
  const input = form.querySelector('input');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const key = input.value.trim();
    input.value = '';
    if (key) tailnet.login(key);
  });
}

export function createTailnet({ worker, traits, idleMs = IDLE_MS, headMs = HEAD_MS }) {
  const waiting = new Map();
  const listeners = new Set();
  let nextId = 0;
  const view = { backend: null, status: null, login: null, failed: null };
  const changed = () => {
    for (const listener of listeners) listener({ ...view });
  };
  const ask = (id, message, transfer = []) =>
    new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage(message, transfer);
    });
  const answer = (id, value, error) => {
    const waiter = waiting.get(id);
    if (!waiter) return;
    waiting.delete(id);
    if (error) waiter.reject(error);
    else waiter.resolve(value);
  };
  const replies = {
    head: (head) => answer(head.id, head),
    dialled: (conn) => answer(conn.id, conn),
    wrote: ({ id, n }) => answer(id, n),
    chunk: ({ id, bytes }) => answer(id, bytes),
    end: ({ id }) => answer(id, null),
    error: ({ id, message, code, status }) =>
      answer(id, null, Object.assign(new Error(message), { code, status: status ?? 502 })),
    backend: (backend) => {
      view.backend = backend;
      if (backend === 'Running') view.login = null;
      changed();
    },
    status: (status) => {
      view.status = status;
      changed();
    },
    login: (url) => {
      view.login = url;
      changed();
    },
    failed: ({ message }) => {
      view.failed = message;
      changed();
    },
    state: (entry) => tailnet.onState?.(entry),
    warning: ({ message }) => console.warn(`tailscale: ${message}`),
  };
  worker.addEventListener('message', ({ data }) => {
    const [kind] = Object.keys(data);
    if (Object.hasOwn(replies, kind)) replies[kind](data[kind]);
  });
  const within = (id, ms, message, transfer = []) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.postMessage({ cancel: id });
        waiting.delete(id);
        reject(
          Object.assign(new Error(`no answer from the tailnet in ${ms / 1000} s`), {
            code: 'ETIMEDOUT',
            status: 504,
          })
        );
      }, ms);
      ask(id, message, transfer)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  const read = (id) => within(id, idleMs, { read: id });
  const tailnet = {
    get view() {
      return { ...view };
    },
    on(listener) {
      listeners.add(listener);
      listener({ ...view });
      return () => listeners.delete(listener);
    },
    routes: (url) => viaTailnet(url, view.status),
    setExitNode: (expr) => worker.postMessage({ exitNode: expr ?? '' }),
    login: (key) => worker.postMessage({ login: key ?? true }),
    async dial(network, addr) {
      const id = ++nextId;
      const conn = await ask(id, { dial: { id, network, addr } });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        worker.postMessage({ close: id });
      };
      return {
        localAddr: conn.localAddr,
        remoteAddr: conn.remoteAddr,
        read: () => (closed ? Promise.resolve(null) : ask(id, { read: id })),
        write: (bytes) => {
          const copy = new Uint8Array(bytes);
          return ask(id, { write: { id, bytes: copy } }, [copy.buffer]);
        },
        close,
      };
    },
    async fetch(request) {
      const id = ++nextId;
      const { signal } = request;
      signal?.throwIfAborted();
      const body = request.body
        ? new Uint8Array(await new Response(request.body).arrayBuffer())
        : undefined;
      const message = {
        fetch: {
          id,
          url: request.url,
          method: request.method,
          headers: request.headers,
          manualRedirects: traits.manualRedirects,
          encodedBodies: traits.encodedBodies,
          ...(body ? { body } : {}),
        },
      };
      let done = false;
      const cancel = async () => {
        if (done) return;
        done = true;
        answer(
          id,
          null,
          Object.assign(new Error('the request was cancelled'), { code: 'ECANCELED' })
        );
        worker.postMessage({ cancel: id });
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const head = await within(id, headMs, message, body ? [body.buffer] : []);
      return {
        status: head.status,
        statusText: head.statusText,
        headers: head.headers,
        cancel,
        body: {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (done) return { value: undefined, done: true };
              const bytes = await read(id);
              if (bytes === null) {
                done = true;
                return { value: undefined, done: true };
              }
              return { value: bytes, done: false };
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
  return tailnet;
}

export function routedTransport(base, tailnet) {
  return {
    traits: base.traits,
    fetch: (request) =>
      tailnet.current?.routes(request.url) ? tailnet.current.fetch(request) : base.fetch(request),
  };
}

export async function readModule(fs, sources = SOURCES) {
  const tried = [];
  for (const dir of sources) {
    try {
      const [wasm, exec] = await Promise.all([
        fs.readFile(`${dir}/main.wasm`),
        fs.readText(`${dir}/wasm_exec.js`),
      ]);
      return { wasm, exec, dir };
    } catch {
      tried.push(dir);
    }
  }
  throw new Error(`no main.wasm and wasm_exec.js in ${tried.join(' or ')}`);
}

function spawn() {
  return new Worker(new URL('tailscale-worker.js', import.meta.url), {
    type: 'module',
    name: 'slicc-tailscale',
  });
}

export function prepareTailscale(network, config, deps = {}) {
  if (!config) return null;
  const store = deps.store ?? stored;
  const slot = { current: null };
  const transport = routedTransport(network.transport, slot);
  const start = async ({ kernel, ready, notice }) => {
    const render = (view) => notice && showTailscale(notice, describeTailscale(view));
    render({ backend: 'loading' });
    try {
      await ready;
      const client = await (deps.attach ?? attachKernel)(await kernel.connect());
      const { wasm, exec } = await readModule(client.fs, config.from ? [config.from] : undefined);
      const worker = (deps.worker ?? spawn)();
      const tailnet = createTailnet({ worker, traits: network.transport.traits });
      const state = (await store('readonly', (s) => s.get(STATE))) ?? {};
      tailnet.onState = ({ key, value }) => {
        state[key] = value;
        void store('readwrite', (s) => s.put(state, STATE));
      };
      tailnet.on((view) => {
        render(view);
        document.documentElement.dataset.tailscale = view.failed
          ? 'failed'
          : (view.backend ?? 'loading');
      });
      const bytes = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
      worker.postMessage(
        {
          start: {
            wasm: bytes,
            exec,
            state,
            config: {
              hostname: config.hostname ?? `slicc-${location.hostname.split('.')[0]}`,
              ...(config.authKey ? { authKey: config.authKey } : {}),
              ...(config.controlURL ? { controlURL: config.controlURL } : {}),
              exitNode: config.exitNode ?? 'auto:any',
              ephemeral: config.ephemeral === true,
            },
          },
        },
        [bytes]
      );
      if (notice) offerKey(notice, tailnet);
      slot.current = tailnet;
      globalThis.sliccTailscale = tailnet;
      return tailnet;
    } catch (error) {
      render({ failed: error.message });
      document.documentElement.dataset.tailscale = 'failed';
      return null;
    }
  };
  return { transport, start };
}
