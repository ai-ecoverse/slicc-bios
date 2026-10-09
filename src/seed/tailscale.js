import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { stored } from './transport.js';
import { fetchText, pnpm, text, versions, write } from './update.js';

const CONFIG = 'tailscale';
const STATE = 'tailscale-state';
const PACKAGE = '@ai-ecoverse/wasm-tailscale';
const FOLDER = 'opt/tailscale';
const RECEIPT = 'var/lib/slicc/tailscale/pnpm-lock.yaml';
const deployed = new URL('../packages/tailscale/', import.meta.url);
const SOURCES = ['/mnt/tailscale', `/${FOLDER}/node_modules/${PACKAGE}/dist`, `/${FOLDER}`];
const IDLE_MS = 30000;
const HEAD_MS = 60000;
const LOOPBACK = new Set(['localhost', '::1']);
const TAILNET = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];
const DOH = 'https://1.1.1.1/dns-query';
const NAME_TTL = 60;

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
    console.warn(
      'tailscale: an auth key in the address was dropped; paste it in the Network panel'
    );
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
  const key = config.enabled ? takeSessionKey(scope) : null;
  return key ? { ...config, authKey: key } : config;
}

export function saveConfig(change, store = stored) {
  return store('readwrite', (s) => s.get(CONFIG)).then(({ authKey, ...saved } = {}) =>
    store('readwrite', (s) => s.put({ ...saved, ...change }, CONFIG))
  );
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

const short = (dnsName, name) => dnsName?.replace(/\.$/, '').split('.')[0] || name;

const STARTING = {
  NoState: 'Starting Tailscale…',
  Starting: 'Connecting to your tailnet…',
  Stopped: 'Tailscale is stopped.',
  NeedsMachineAuth: 'Waiting for this browser to be approved in the Tailscale admin console.',
  InUseOtherUser: 'Tailscale is in use by another user.',
};

export function panelStatus(view, enabled) {
  if (!enabled) return { state: 'off' };
  if (view.failed) return { state: 'failed', detail: view.failed };
  if (!view.backend) return { state: 'loading', detail: view.installing ?? 'Loading Tailscale…' };
  if (view.login || view.backend === 'NeedsLogin')
    return { state: 'needs-login', ...(view.login ? { loginUrl: view.login } : {}) };
  if (view.backend !== 'Running' || !view.status)
    return { state: 'starting', detail: STARTING[view.backend] ?? `Tailscale: ${view.backend}` };
  const { self, exitNode, peers = [] } = view.status;
  return {
    state: 'running',
    node: { name: short(self?.dnsName, self?.name), addresses: self?.addresses ?? [] },
    exitNode: exitNode ? short(exitNode.dnsName, exitNode.name) : null,
    exitNodes: peers
      .filter((peer) => peer.exitNodeOption)
      .map((peer) => ({ id: peer.id, name: short(peer.dnsName, peer.name), online: peer.online })),
    autoExitNode: Boolean(view.status.autoExitNode),
    shieldsUp: view.status.shieldsUp === true,
    peers: peers.length,
  };
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
    done: ({ id }) => answer(id, undefined),
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
    setExitNode(expr) {
      const id = ++nextId;
      return ask(id, { exitNode: { id, expr: expr ?? '' } });
    },
    logout() {
      const id = ++nextId;
      return ask(id, { logout: id });
    },
    login: (key) => worker.postMessage({ login: key ?? true }),
    stop() {
      worker.terminate?.();
      for (const id of [...waiting.keys()])
        answer(
          id,
          null,
          Object.assign(new Error('Tailscale was turned off'), { code: 'ECANCELED' })
        );
    },
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
        closeWrite: () => {
          if (!closed) worker.postMessage({ closeWrite: id });
        },
        write: (bytes) => {
          const copy = new Uint8Array(bytes);
          const op = ++nextId;
          return ask(op, { write: { id, op, bytes: copy } }, [copy.buffer]);
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

export function routeTable(status) {
  if (status?.state !== 'Running') return { prefixes: [], exit: false };
  return { prefixes: TAILNET, exit: Boolean(status.exitNode) };
}

export function reserved(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(mapped?.[1] ?? bare);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    return (
      a === 0 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 10 && b === 0 && c === 2 && d === 2)
    );
  }
  return bare === '::' || bare === '::1' || /^(fe[89ab]|ff)/.test(bare) || !bare.includes(':');
}

export function tailnetNames(name, status) {
  const want = name.replace(/\.$/, '').toLowerCase();
  const nodes = [status?.self, ...(status?.peers ?? [])].filter(Boolean);
  for (const node of nodes) {
    const dns = (node.dnsName ?? '').replace(/\.$/, '').toLowerCase();
    if (dns && (dns === want || dns.split('.')[0] === want)) return node.addresses ?? [];
  }
  return null;
}

const v6 = (address) => address.includes(':');
const pick = (addresses, family) =>
  addresses.filter((a) => (family === 4 ? !v6(a) : family === 6 ? v6(a) : true));

async function readAll(response) {
  const chunks = [];
  for await (const chunk of response.body) chunks.push(...chunk);
  return new TextDecoder().decode(new Uint8Array(chunks));
}

export async function resolveOverExit(tailnet, name, family, signal) {
  const types = family === 6 ? ['AAAA'] : family === 4 ? ['A'] : ['A', 'AAAA'];
  const addresses = [];
  let ttl = NAME_TTL;
  for (const type of types) {
    const url = `${DOH}?${new URLSearchParams({ name, type })}`;
    const response = await tailnet.fetch({
      url,
      method: 'GET',
      headers: [['accept', 'application/dns-json']],
      signal,
    });
    if (response.status !== 200) {
      await response.cancel();
      continue;
    }
    const answer = JSON.parse(await readAll(response));
    for (const record of answer.Answer ?? []) {
      if (record.type !== 1 && record.type !== 28) continue;
      addresses.push(record.data);
      ttl = Math.min(ttl, record.TTL ?? NAME_TTL);
    }
  }
  return { addresses, ttl };
}

const unreachable = (message, code = 'ENETUNREACH') => Object.assign(new Error(message), { code });

export function createUplink(slot) {
  return {
    traits: { tcp: true, udp: false, ipv6: false },
    routes: { prefixes: [], exit: false },
    async resolve(name, family, signal) {
      const tailnet = slot.current;
      const status = tailnet?.view.status;
      if (status?.state !== 'Running') return [];
      const known = tailnetNames(name, status);
      if (known) return { addresses: pick(known, family), ttl: NAME_TTL };
      if (!status.exitNode) return [];
      return resolveOverExit(tailnet, name, family, signal);
    },
    async dial({ host, port, signal }) {
      const tailnet = slot.current;
      if (!tailnet) throw unreachable('Tailscale is not running');
      if (reserved(host)) throw unreachable(`the tailnet does not carry ${host}`);
      signal?.throwIfAborted();
      const conn = await tailnet.dial('tcp', v6(host) ? `[${host}]:${port}` : `${host}:${port}`);
      return {
        localAddr: conn.localAddr,
        remoteAddr: conn.remoteAddr,
        read: () => conn.read(),
        write: (bytes) => conn.write(bytes),
        closeWrite: () => conn.closeWrite(),
        close: () => conn.close(),
      };
    },
  };
}

export function installTailscale(start, options = {}) {
  const { from = deployed, report = () => {}, locks = navigator.locks, root } = options;
  return locks.request('slicc-tailscale', async () => {
    const dir = root ?? (await navigator.storage.getDirectory());
    const lock = await fetchText('pnpm-lock.yaml', from);
    if (lock === (await text(dir, RECEIPT))) return false;
    const manifest = await fetchText('package.json', from);
    await write(dir, `${FOLDER}/package.json`, manifest);
    await write(dir, `${FOLDER}/pnpm-lock.yaml`, lock);
    const kernel = await start();
    try {
      await pnpm(kernel, `/${FOLDER}`, report, JSON.parse(manifest).dependencies?.[PACKAGE]);
    } finally {
      kernel.terminate();
    }
    await write(dir, RECEIPT, lock);
    return true;
  });
}

export async function tailscaleVersion(root) {
  const dir = root ?? (await navigator.storage.getDirectory());
  return (await versions(dir, [PACKAGE], `${FOLDER}/`))[PACKAGE];
}

export function installing({ progress }) {
  if (!progress) return 'Installing Tailscale…';
  const verb = progress.phase === 'link' ? 'linking' : 'downloading';
  return `Installing Tailscale (${verb} ${progress.done} of ${progress.total})…`;
}

function spawn() {
  return new Worker(new URL('tailscale-worker.js', import.meta.url), {
    type: 'module',
    name: 'slicc-tailscale',
  });
}

const EXIT = { auto: 'auto:any' };

export function createTailscale(config, deps = {}) {
  const store = deps.store ?? stored;
  const slot = { current: null };
  const listeners = new Set();
  let enabled = config.enabled === true;
  let view = { backend: null, status: null, login: null, failed: null };
  let context = null;
  let starting = null;
  let authKey = config.authKey;
  const uplink = createUplink(slot);
  let routes = JSON.stringify(uplink.routes);
  const syncRoutes = () => {
    const table = routeTable(slot.current ? view.status : null);
    const next = JSON.stringify(table);
    if (next === routes || !context?.kernel?.setRoutes) return;
    routes = next;
    context.kernel
      .setRoutes(table)
      .catch((error) => console.warn(`tailscale routes: ${error.message}`));
  };
  const changed = () => {
    syncRoutes();
    document.documentElement.dataset.tailscale = !enabled
      ? 'off'
      : view.failed
        ? 'failed'
        : (view.backend ?? 'loading');
    for (const listener of [...listeners]) listener();
  };
  const running = () => {
    if (!slot.current) throw new Error('Tailscale is not running.');
    return slot.current;
  };
  const boot = async () => {
    view = { backend: null, status: null, login: null, failed: null };
    changed();
    try {
      await context.ready;
      if (context.install) {
        await context.install((step) => {
          view = { ...view, installing: installing(step) };
          changed();
        });
        view = { ...view, installing: null };
      }
      const client = await (deps.attach ?? attachKernel)(await context.kernel.connect());
      const { wasm, exec } = await readModule(client.fs, config.from ? [config.from] : undefined);
      const worker = (deps.worker ?? spawn)();
      const tailnet = createTailnet({ worker, traits: context.traits });
      const state = (await store('readonly', (s) => s.get(STATE))) ?? {};
      tailnet.onState = ({ key, value }) => {
        state[key] = value;
        void store('readwrite', (s) => s.put(state, STATE));
      };
      tailnet.on((next) => {
        view = next;
        changed();
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
              ...(authKey ? { authKey } : {}),
              ...(config.controlURL ? { controlURL: config.controlURL } : {}),
              exitNode: config.exitNode ?? 'auto:any',
              ephemeral: config.ephemeral === true,
            },
          },
        },
        [bytes]
      );
      authKey = undefined;
      slot.current = tailnet;
      if (globalThis.sliccTailscaleDebug === true) globalThis.sliccTailscale = tailnet;
      return tailnet;
    } catch (error) {
      view = { ...view, failed: `Tailscale didn't start: ${error.message}.` };
      changed();
      return null;
    }
  };
  const stop = () => {
    slot.current?.stop();
    slot.current = null;
    starting = null;
    view = { backend: null, status: null, login: null, failed: null };
  };
  const panel = {
    status: () => panelStatus(view, enabled),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setTailnet(on) {
      enabled = on;
      config = { ...config, enabled: on };
      await saveConfig({ enabled: on }, store);
      if (!on) stop();
      else if (context && !starting) starting = boot();
      changed();
      await starting;
    },
    async setExitNode(choice) {
      const expr = choice === null ? '' : (EXIT[choice] ?? choice);
      await running().setExitNode(expr);
      config = { ...config, exitNode: expr };
      await saveConfig({ exitNode: expr }, store);
    },
    async submitAuthKey(key) {
      const trimmed = key.trim();
      if (!trimmed.startsWith('tskey-')) throw new Error('That is not a Tailscale auth key.');
      running().login(trimmed);
    },
    async logoutTailnet() {
      await running().logout();
    },
    async check() {
      if (!enabled) return;
      stop();
      starting = boot();
      changed();
      await starting;
    },
  };
  return {
    panel,
    uplink,
    wrap: (base) => routedTransport(base, slot),
    start({ kernel, ready, traits, install }) {
      context = { kernel, ready, traits, install };
      changed();
      if (enabled && !starting) starting = boot();
      return starting;
    },
  };
}
