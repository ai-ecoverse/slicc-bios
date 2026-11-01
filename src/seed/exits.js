import { datagrams } from './link-udp.js';
import { hasPlaceholder, SEALED } from './placeholders.js';
import { checkRedirect, redirectMode } from './redirects.js';

export const KERNEL_NAMES = ['emscripten', 'slicc', 'wasmer.sh'];
const LOOPBACK = new Set(['localhost', '::1']);
const REMEMBER = 50;

export function bareHost(host) {
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

export function loopback(host) {
  const bare = bareHost(host);
  return LOOPBACK.has(bare) || bare.startsWith('127.');
}

export function reserved(host) {
  const bare = bareHost(host);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  const words = hex?.slice(1).map((word) => Number.parseInt(word, 16));
  const dotted = words && [words[0] >> 8, words[0] & 255, words[1] >> 8, words[1] & 255].join('.');
  const mapped = dotted ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare)?.[1];
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(mapped ?? bare);
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

export function ownName(name, own) {
  const bare = name.replace(/\.$/, '').toLowerCase();
  return own.has(bare) || own.has(bare.split('.')[0]);
}

const v6 = (address) => address.includes(':');

export function pick(addresses, family) {
  return addresses.filter((a) => (family === 4 ? !v6(a) : family === 6 ? v6(a) : true));
}

const unreachable = (message, code = 'ENETUNREACH') => Object.assign(new Error(message), { code });

export function held(id) {
  const fail = async () => {
    throw unreachable(`the exit ${id} isn't connected, so internet traffic waits for it`);
  };
  return {
    id,
    kind: 'held',
    held: true,
    active: () => false,
    offersDefault: () => true,
    claims: () => false,
    prefixes: () => [],
    knows: () => null,
    resolve: async () => [],
    dial: fail,
    udp: fail,
    fetch: fail,
    websocket: fail,
  };
}

export { SEALED };
export const NO_SEALED_WEBSOCKET = "secrets in WebSocket handshakes aren't supported yet";

const sealed = hasPlaceholder;

export const NO_WEBSOCKET =
  'WebSockets go out only through an exit: link a slicc CLI (npx sliccy@next), or use a Tailscale exit node';

export const DIRECT = 'direct';

const TAILNET_CAPS = ['net', 'http'];

export function describe(exit) {
  if (exit.kind === 'link')
    return { kind: exit.automatic ? 'local' : 'remote', caps: [...exit.caps()] };
  if (exit.kind === 'tailnet')
    return {
      kind: 'tailnet',
      caps: [...TAILNET_CAPS, ...(exit.websocket ? ['ws'] : []), ...(exit.udp ? ['udp'] : [])],
    };
  return { kind: String(exit.kind ?? 'exit'), caps: [...(exit.caps?.() ?? [])] };
}

export function routedUdp({ family, signal }, choose) {
  const messages = datagrams();
  let opening = null;
  let closed = false;
  const close = () => {
    signal?.removeEventListener('abort', close);
    closed = true;
    messages.end();
    opening?.then((socket) => socket.close()).catch(() => {});
  };
  signal?.addEventListener('abort', close, { once: true });
  const forward = async (socket) => {
    try {
      for await (const message of socket.messages) messages.push(message);
    } finally {
      close();
    }
  };
  const open = (host) => {
    const exit = choose(host);
    if (!exit) return Promise.reject(unreachable(`no exit carries ${host}`));
    if (!exit.udp) return Promise.reject(unreachable(`the exit ${exit.id} carries no UDP`));
    const socket = Promise.resolve().then(() => exit.udp({ family, signal }));
    socket.then(
      (opened) => (closed ? opened.close() : void forward(opened).catch(() => {})),
      () => {}
    );
    return socket;
  };
  return {
    localAddr: '',
    messages,
    close,
    async send(bytes, host, port) {
      if (closed) throw unreachable('the UDP socket is closed');
      const pending = (opening ??= open(host));
      const socket = await pending.catch((error) => {
        if (opening === pending) opening = null;
        throw error;
      });
      if (closed) throw unreachable('the UDP socket is closed');
      await socket.send(bytes, host, port);
    },
  };
}

function credentialedSelection(url, base, protectedUrl, { httpCarrier, own, exits, onChange }) {
  const host = bareHost(new URL(url).hostname).replace(/\.$/, '');
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
  const carrier = httpCarrier(host);
  const local = loopback(host) && carrier?.hostLoopback?.() === true;
  if (
    (!local && loopback(host)) ||
    ownName(host, own) ||
    (literal && reserved(host) && !local) ||
    /^(?:\d+\.)?kernel\.localhost$/.test(host) ||
    protectedUrl(url)
  )
    return null;
  const sender = carrier ? carrier.credentialed : base;
  if (sender?.traits?.manualRedirects !== true || sender.traits?.encodedBodies !== false)
    return null;
  const exit = carrier ? carrier.exitName?.() : 'page';
  if (typeof exit !== 'string') return null;
  return {
    exit,
    rawTraits: { manualRedirects: true, encodedBodies: false },
    maxRequestBody: sender.traits.maxRequestBody,
    streamingBodies: sender.traits.streamingBodies === true,
    active: () =>
      httpCarrier(host) === carrier &&
      (carrier
        ? carrier.active() === true &&
          exits.includes(carrier) &&
          carrier.exitName?.() === exit &&
          sender.active?.() === true
        : sender.active() === true),
    onChange,
    fetch: (request) => sender.fetch({ ...request, redirect: 'manual' }),
  };
}

function honorsRedirect(traits, mode) {
  return (
    traits.redirectPolicy === true ||
    (mode === 'manual' &&
      traits.manualRedirects === true &&
      (traits.redirectHops === undefined || traits.redirectHops === false))
  );
}

export function createExitRouter({ protectedUrl = () => false } = {}) {
  const exits = [];
  const listeners = new Set();
  const own = new Set(KERNEL_NAMES);
  const asked = [];
  const forwarded = [];
  let kernel = null;
  let pushed = JSON.stringify({ prefixes: [], exit: false });
  const remember = (list, name) => {
    list.push(name);
    if (list.length > REMEMBER) list.shift();
  };
  let chosen = null;
  const active = () => exits.filter((exit) => exit.active());
  const fallback = () => {
    if (chosen === null || chosen === DIRECT) {
      const offering = active().filter((exit) => exit.offersDefault());
      const own = offering.find((exit) => !exit.chosenOnly);
      if (own || chosen === DIRECT) return own ?? null;
      return offering.find((exit) => exit.automatic) ?? null;
    }
    const exit = exits.find((item) => item.id === chosen);
    return exit?.active() && exit.offersDefault() ? exit : held(chosen);
  };
  const carrier = (host) => active().find((exit) => exit.claims(host)) ?? fallback();
  const httpCarrier = (host) => {
    const bare = bareHost(host).replace(/\.$/, '');
    const literal = /^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.includes(':');
    if (loopback(bare)) return active().find((exit) => exit.hostLoopback?.()) ?? null;
    if (literal ? reserved(bare) : ownName(bare, own)) return null;
    const claimant = active().find((exit) => exit.claims(bare));
    if (claimant) return claimant;
    return literal || bare.includes('.') ? fallback() : null;
  };

  const router = {
    own,
    exits,
    add(exit) {
      exits.push(exit);
      router.sync();
      return exit;
    },
    remove(exit) {
      const at = exits.indexOf(exit);
      if (at >= 0) exits.splice(at, 1);
      router.sync();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selectCredentialed(url, base, protectedUrl = () => false) {
      return credentialedSelection(url, base, protectedUrl, {
        httpCarrier,
        own,
        exits,
        onChange: router.onChange,
      });
    },
    defaultExit: fallback,
    chosen: () => chosen,
    choose(id) {
      chosen = id ?? null;
      router.sync();
    },
    table() {
      return {
        prefixes: [...new Set(active().flatMap((exit) => exit.prefixes()))],
        exit: Boolean(fallback()),
      };
    },
    attach(attached) {
      kernel = attached;
      router.sync();
    },
    sync() {
      for (const listener of listeners) listener();
      kernel
        ?.updateTransportTraits?.()
        .catch((error) => console.warn(`exit traits: ${error.message}`));
      const table = router.table();
      const next = JSON.stringify(table);
      if (next === pushed || !kernel?.setRoutes) return;
      pushed = next;
      kernel.setRoutes(table).catch((error) => console.warn(`exit routes: ${error.message}`));
    },
    routes: (url) => {
      return Boolean(httpCarrier(new URL(url).hostname));
    },
    transport(base) {
      return {
        get traits() {
          const exit = fallback();
          const about = exit && !exit.held ? describe(exit) : null;
          return {
            ...base.traits,
            redirectPolicy: base.traits.redirectPolicy === true,
            websocket: true,
            ...(about ? { exit: about } : {}),
          };
        },
        async fetch(request) {
          if (hasPlaceholder(request))
            throw Object.assign(new TypeError('the request carries an unfilled placeholder'), {
              status: 403,
              code: 'EACCES',
            });
          const mode = redirectMode(request);
          if (mode !== 'follow' && protectedUrl(request.url))
            throw Object.assign(new TypeError('the request names a protected origin'), {
              status: 403,
              code: 'EACCES',
            });
          const exit = httpCarrier(new URL(request.url).hostname);
          if (mode !== 'follow' && !honorsRedirect(exit ?? base.traits, mode))
            throw Object.assign(
              new TypeError('the selected exit cannot honor this redirect policy'),
              { status: 502, code: 'EACCES' }
            );
          const response = await (exit ? exit.fetch(request) : base.fetch(request));
          return checkRedirect(request, response);
        },
        async websocket(request) {
          if (sealed(request))
            throw Object.assign(new Error(NO_SEALED_WEBSOCKET), { code: 'EACCES', status: 502 });
          const exit = httpCarrier(new URL(request.url).hostname);
          if (exit?.websocket) return exit.websocket(request);
          const why = exit ? `the exit ${exit.id} carries no WebSockets` : NO_WEBSOCKET;
          if (!exit && base.websocket) return base.websocket(request);
          throw Object.assign(new Error(why), { status: exit ? 502 : 501 });
        },
      };
    },
    uplink: {
      traits: { tcp: true, udp: true, ipv6: false },
      routes: { prefixes: [], exit: false },
      asked,
      forwarded,
      own,
      async resolve(name, family, signal) {
        remember(asked, name);
        if (ownName(name, own)) return [];
        for (const exit of active()) {
          const known = exit.knows(name);
          if (known) return { addresses: pick(known, family), ttl: 60 };
        }
        const exit = fallback();
        if (!exit || !name.replace(/\.$/, '').includes('.')) return [];
        remember(forwarded, name);
        return exit.resolve(name, family, signal);
      },
      async dial({ host, port, signal }) {
        if (reserved(host)) throw unreachable(`no exit carries ${host}`);
        const exit = carrier(host);
        if (!exit) throw unreachable(`no exit carries ${host}`);
        signal?.throwIfAborted();
        const conn = await exit.dial({ host, port, signal });
        const named = exit.exitName?.() ?? null;
        return {
          ...(named ? { exit: named } : {}),
          localAddr: conn.localAddr,
          remoteAddr: conn.remoteAddr,
          read: () => conn.read(),
          write: (bytes) => conn.write(bytes),
          closeWrite: () => conn.closeWrite(),
          close: () => conn.close(),
        };
      },
      async udp({ family, signal }) {
        signal?.throwIfAborted();
        return routedUdp({ family, signal }, (host) => (reserved(host) ? null : carrier(host)));
      },
    },
  };
  if (globalThis.sliccUplinkDebug === true) globalThis.sliccUplink = router.uplink;
  return router;
}
