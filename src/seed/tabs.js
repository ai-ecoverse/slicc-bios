import { SWITCHBOARD_LOCK, TAB_LOCK, VERSION } from './switchboard.js';

export const OWNER_LOCK = 'slicc-agent';
export const NOTICE = '\r\n[the tab running SLICC closed; starting a new shell]\r\n';

export function hold(locks, name) {
  return new Promise((acquired, failed) => {
    locks
      .request(name, { mode: 'exclusive' }, () => new Promise((release) => acquired(release)))
      .catch(failed);
  });
}

export function claim(locks = navigator.locks, name = OWNER_LOCK) {
  return new Promise((resolve, failed) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve({ owner: false, next: hold(locks, name) });
          return undefined;
        }
        return new Promise((release) => resolve({ owner: true, release }));
      })
      .catch(failed);
  });
}

export function supported(scope = globalThis) {
  return typeof scope.SharedWorker === 'function';
}

function openSwitchboard() {
  const url = new URL('switchboard-worker.js', import.meta.url);
  return new SharedWorker(url, { type: 'module', name: 'slicc-switchboard' }).port;
}

const NAMES = ['agent', 'kernel', 'os'];

export async function joinSwitchboard({
  open = openSwitchboard,
  locks = navigator.locks,
  id = crypto.randomUUID(),
  visible = true,
  versions = null,
  retry = 1000,
} = {}) {
  const listeners = new Map();
  const pending = new Map();
  let port = null;
  let owner = null;
  let serving = null;
  let shown = visible;
  let next = 0;

  const emit = (type, value) => {
    for (const listener of listeners.get(type) ?? []) listener(value);
  };
  const send = (frame, transfer = []) => port.postMessage({ v: VERSION, ...frame }, transfer);
  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  async function answer(want) {
    const to = want.from;
    try {
      const given = await serving(to);
      const names = NAMES.filter((name) => given[name]);
      send(
        { give: { id: want.id, to, names } },
        names.map((name) => given[name])
      );
    } catch (error) {
      send({ give: { id: want.id, to, error: error.message } });
    }
  }

  function delivered(give, ports) {
    const waiting = pending.get(give.id);
    if (!waiting) {
      for (const given of ports) given.close?.();
      return;
    }
    pending.delete(give.id);
    if (give.error) waiting.reject(new Unanswered(give.error));
    else
      waiting.resolve(
        Object.fromEntries(NAMES.map((name) => [name, ports[give.names.indexOf(name)] ?? null]))
      );
  }

  function receive(data, ports, welcomed, refused) {
    if (data.refused) refused(new Error(`the switchboard refused this tab: ${data.refused}`));
    else if (data.welcome) {
      owner = data.welcome.owner;
      welcomed();
    } else if (data.owner) {
      owner = data.owner;
      fail(new Moved());
      emit('owner', owner);
    } else if (data.want && serving) void answer(data.want);
    else if (data.give) delivered(data.give, ports);
    else if ('ping' in data) send({ pong: data.ping });
    else if (data.stalled) emit('stalled', data.stalled);
    else if (data.unstalled) emit('unstalled', true);
    else if (data.replaced) emit('replaced', true);
  }

  function connect() {
    return new Promise((welcomed, refused) => {
      port = open();
      port.addEventListener('message', ({ data, ports }) =>
        receive(data, ports, welcomed, refused)
      );
      port.start();
      send({ hello: { tab: id, visible: shown, versions } });
    }).then(() => {
      if (serving) send({ own: { versions } });
      void locks.request(SWITCHBOARD_LOCK, () => {
        fail(new Moved());
        void connect().then(() => emit('owner', owner));
      });
    });
  }

  function settled() {
    if (owner?.tab) return Promise.resolve(owner);
    return new Promise((resolve) => {
      const off = board.on('owner', (value) => {
        off();
        resolve(value);
      });
    });
  }

  const board = {
    id,
    owner: () => owner,
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    show(value) {
      shown = Boolean(value);
      send({ visible: shown });
    },
    own(give) {
      serving = give;
      send({ own: { versions } });
    },
    async ports() {
      for (;;) {
        const current = await settled();
        if (current.tab === id && serving) return serving(id);
        next += 1;
        const request = next;
        const answered = new Promise((resolve, reject) =>
          pending.set(request, { resolve, reject })
        );
        send({ want: { id: request } });
        try {
          return await answered;
        } catch (error) {
          if (error instanceof Unanswered)
            await new Promise((resolve) => setTimeout(resolve, retry));
        }
      }
    },
  };

  await hold(locks, `${TAB_LOCK}${id}`);
  await connect();
  return board;
}

export class Moved extends Error {
  constructor() {
    super('the tab running SLICC changed');
    this.name = 'Moved';
  }
}

export class Unanswered extends Error {
  constructor(message) {
    super(message);
    this.name = 'Unanswered';
  }
}

const gone = (error) => error?.name === 'KernelGoneError';
const encoder = new TextEncoder();

export function followKernel({ port, attach, notice = NOTICE }) {
  let current = null;
  let live = null;

  function forget(attached) {
    if (live !== attached) return;
    live = null;
    current = null;
  }

  function client() {
    if (current) return current;
    const attaching = (async () => {
      for (;;) {
        try {
          const attached = await attach(await port());
          void attached.closed.then(() => forget(attached));
          live = attached;
          return attached;
        } catch (error) {
          if (!gone(error)) {
            current = null;
            throw error;
          }
        }
      }
    })();
    current = attaching;
    return attaching;
  }

  async function openTerminal(argv, { cwd, env, cols, rows, onData }) {
    const size = { cols, rows };
    let inner = null;
    let closed = false;
    let finish;
    const exited = new Promise((resolve) => {
      finish = resolve;
    });
    const output = (bytes) => onData?.(bytes);
    async function open() {
      let used;
      for (;;) {
        used = await client();
        try {
          inner = await used.openTerminal(argv, { cwd, env, ...size, onData: output });
          if (closed) inner.close();
          break;
        } catch (error) {
          if (!gone(error)) throw error;
          forget(used);
        }
      }
      inner.exited.then(finish, (error) => {
        inner = null;
        if (gone(error)) forget(used);
        if (!gone(error)) {
          output(encoder.encode(`\r\n${error.message}\r\n`));
          finish(1);
          return;
        }
        output(encoder.encode(notice));
        open().catch((failure) => {
          output(encoder.encode(`\r\n${failure.message}\r\n`));
          finish(1);
        });
      });
    }
    await open();
    return {
      get pid() {
        return inner?.pid ?? null;
      },
      exited,
      write: (data) => inner?.write(data),
      resize(columns, lines) {
        size.cols = columns;
        size.rows = lines;
        inner?.resize(columns, lines);
      },
      signal: (name) => inner?.signal(name),
      close() {
        closed = true;
        inner?.close();
      },
    };
  }

  const through =
    (name) =>
    async (...args) =>
      (await client())[name](...args);

  return {
    client,
    openTerminal,
    connect: port,
    loopbackFetch: through('loopbackFetch'),
    run: through('run'),
    ps: through('ps'),
    kill: through('kill'),
    mounts: through('mounts'),
  };
}

export function createOs(handlers) {
  const ports = new Set();
  return {
    open() {
      const { port1, port2 } = new MessageChannel();
      ports.add(port1);
      port1.addEventListener('message', async ({ data }) => {
        if (data?.close) {
          ports.delete(port1);
          port1.close();
          return;
        }
        const { id, call, args = [] } = data ?? {};
        const handler = Object.hasOwn(handlers, call) ? handlers[call] : null;
        try {
          if (!handler) throw new Error(`the tab running SLICC has no ${call}`);
          port1.postMessage({ id, result: await handler(...args) });
        } catch (error) {
          port1.postMessage({ id, error: error.message });
        }
      });
      port1.start();
      return port2;
    },
    emit(event, value) {
      for (const port of ports) port.postMessage({ event, value });
    },
  };
}

export function osClient(port) {
  const pending = new Map();
  const listeners = new Map();
  let next = 0;
  let ended = null;
  port.addEventListener('message', ({ data }) => {
    if (data.event) {
      for (const listener of listeners.get(data.event) ?? []) listener(data.value);
      return;
    }
    const waiting = pending.get(data.id);
    if (!waiting) return;
    pending.delete(data.id);
    if ('error' in data) waiting.reject(new Error(data.error));
    else waiting.resolve(data.result);
  });
  port.start();
  return {
    call(call, ...args) {
      if (ended) return Promise.reject(ended);
      next += 1;
      const id = next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ id, call, args });
      });
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event).delete(listener);
    },
    close(error = new Moved()) {
      if (ended) return;
      ended = error;
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
      port.postMessage({ close: true });
      port.close();
    },
  };
}

function parts(version) {
  const [core, pre] = String(version).split('+')[0].split(/-(.*)/s);
  const number = (part) => (/^\d+$/.test(part) ? Number(part) : part);
  return { core: core.split('.').map(number), pre: pre ? pre.split('.').map(number) : [] };
}

function order(x, y) {
  if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;
  return x > y ? 1 : -1;
}

function compare(x, y, missing) {
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined) return -missing;
    if (y[i] === undefined) return missing;
    return order(x[i], y[i]);
  }
  return 0;
}

export function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  const core = compare(x.core, y.core, 1);
  if (core) return core > 0;
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0;
  return compare(x.pre, y.pre, 1) > 0;
}

export function skew(mine, theirs) {
  for (const key of ['bios', 'agent']) {
    const [a, b] = [mine?.[key], theirs?.[key]];
    if (!a || !b || (!newer(a, b) && !newer(b, a))) continue;
    return newer(b, a) ? 'newer' : 'older';
  }
  return null;
}
