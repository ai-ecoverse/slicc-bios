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
    fetch: fail,
  };
}

export function createExitRouter() {
  const exits = [];
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
    if (chosen === null)
      return active().find((exit) => !exit.chosenOnly && exit.offersDefault()) ?? null;
    const exit = exits.find((item) => item.id === chosen);
    return exit?.active() && exit.offersDefault() ? exit : held(chosen);
  };
  const carrier = (host) => active().find((exit) => exit.claims(host)) ?? fallback();
  const httpCarrier = (host) => {
    const bare = bareHost(host).replace(/\.$/, '');
    const literal = /^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.includes(':');
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
        traits: base.traits,
        fetch(request) {
          const exit = httpCarrier(new URL(request.url).hostname);
          return exit ? exit.fetch(request) : base.fetch(request);
        },
      };
    },
    uplink: {
      traits: { tcp: true, udp: false, ipv6: false },
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
        return {
          localAddr: conn.localAddr,
          remoteAddr: conn.remoteAddr,
          read: () => conn.read(),
          write: (bytes) => conn.write(bytes),
          closeWrite: () => conn.closeWrite(),
          close: () => conn.close(),
        };
      },
    },
  };
  return router;
}
