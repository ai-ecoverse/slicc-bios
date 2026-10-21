export const components = [
  ['agent', 'agent', 'Agent (/opt/agent)'],
  ['kernel', 'kernel', 'Kernel'],
  ['ui', 'ui', 'UI'],
  ['bios', 'bios', 'BIOS packages'],
  ['grammars', 'grammars', 'Syntax grammars'],
  ['tailscale', 'tailscale', 'Tailscale (/opt/tailscale)'],
];

export const owners = {
  kernel: '@ai-ecoverse/slicc-kernel',
  ui: '@ai-ecoverse/slicc-spectrum',
};

const RUNNING = { download: 'downloading', link: 'linking' };
export const OWNER_ACTIONS = new Set(['install-beta', 'back-to-certified']);
const BUSY = new Set(['queued', 'starting', 'checking', 'downloading', 'linking']);
const SETTLE = new Set(['queued', 'starting', 'checking', 'downloading', 'linking', 'failed']);

const NAMES = {
  agent: 'the agent',
  kernel: 'the BIOS packages',
  ui: 'the BIOS packages',
  bios: 'the BIOS packages',
  grammars: 'the syntax grammars',
  tailscale: 'Tailscale',
};
const UNREACHABLE = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b/;

export function explain(item, error) {
  if (error.plain) return error.plain;
  if (error.log === undefined) {
    return `Couldn't check ${NAMES[item.id]} for updates (${error.message}). Retry, or check the network.`;
  }
  const subject = `${NAMES[item.id]}${item.from === null ? '' : ' update'}${error.to ? ` ${error.to}` : ''}`;
  const raw = `${error.message}\n${error.log}`;
  if (/ERR_PNPM_FETCH_404|ERR_PNPM_NO_MATCHING_VERSION/.test(raw)) {
    return `Couldn't download ${subject}: the registry doesn't have it (404). Retry later.`;
  }
  if (/INTEGRITY|EINTEGRITY/i.test(raw)) {
    return `Couldn't install ${subject}: the download was damaged. Retry.`;
  }
  const code = raw.match(UNREACHABLE)?.[1];
  if (code || /ERR_PNPM_\w*FETCH|Failed to fetch/.test(raw)) {
    return `Couldn't download ${subject}: the registry wasn't reachable${code ? ` (${code})` : ''}. Retry, or check the network.`;
  }
  return `Couldn't install ${subject}: pnpm stopped with an error, shown in the install log. Retry.`;
}

export function count(n) {
  return `${n} ${n === 1 ? 'package' : 'packages'}`;
}

function extras(item, beta) {
  if (!beta || BUSY.has(item.state)) return [];
  return [
    ...(beta.npm?.state === 'offered' ? ['install-beta'] : []),
    ...(beta.beta ? ['back-to-certified'] : []),
  ];
}

function noted(item, notes) {
  const { releases: _, ...rest } = item;
  const list = notes?.pick(item.id, item.from, item.to);
  return list ? { ...rest, releases: list } : rest;
}

export function createUpdates({
  ready = false,
  now = Date.now,
  developer = false,
  notes = null,
} = {}) {
  const listeners = { items: new Set(), packages: new Set() };
  const handlers = new Map();
  let packages = [];
  let offered = [];
  let own = [];
  let packageHandler = null;
  let ownHandler = null;
  let developerHandler = null;
  const betas = new Map();
  const listed = () => {
    const all = [...own, ...packages];
    for (const listener of [...listeners.packages]) listener(all);
  };
  let items = components.map(([id, kind, label]) => ({
    id,
    label,
    kind,
    state: 'current',
    progress: null,
    from: null,
    to: null,
    checkedAt: null,
    error: null,
    actions: [],
  }));
  const shown = (item) => {
    const beta = betas.get(item.id);
    if (!beta) return item;
    return {
      ...item,
      beta: beta.beta ?? null,
      npm: beta.npm ?? null,
      actions: [...item.actions, ...extras(item, beta)],
    };
  };
  const all = () => items.map(shown);
  const emit = () => {
    const list = all();
    for (const listener of [...listeners.items]) listener(list);
  };
  const port = {
    on(type, listener) {
      const set = Object.hasOwn(listeners, type) ? listeners[type] : null;
      if (!set) return () => {};
      set.add(listener);
      return () => set.delete(listener);
    },
    list: all,
    packages: () => [...own, ...packages],
    setPackages(list) {
      offered = list;
      packages = notes ? notes.annotate(list) : list;
      listed();
    },
    renote() {
      packages = notes ? notes.annotate(offered) : offered;
      items = items.map((item) => noted(item, notes));
      listed();
      emit();
    },
    userPackages: () => own,
    setUserPackages(list) {
      own = list;
      listed();
    },
    handlePackages(handler) {
      packageHandler = handler;
    },
    async refreshPackages() {
      await packageHandler?.('', 'refresh');
    },
    handleUserPackages(handler) {
      ownHandler = handler;
    },
    async actPackage(id, action) {
      if (id.startsWith('user:')) {
        if (!ownHandler) throw new Error('Your packages are not available yet.');
        await ownHandler(id, action);
        return;
      }
      if (!packageHandler) throw new Error('Optional packages are not available yet.');
      await packageHandler(id, action);
    },
    ready: () => ready,
    get(id) {
      const item = items.find((one) => one.id === id);
      return item && shown(item);
    },
    setBeta(id, patch) {
      betas.set(id, { ...betas.get(id), ...patch });
      emit();
    },
    handleDeveloper(handler) {
      developerHandler = handler;
      emit();
    },
    set(id, patch) {
      items = items.map((item) => (item.id === id ? noted({ ...item, ...patch }, notes) : item));
      emit();
    },
    setReady(value) {
      if (ready === value) return;
      ready = value;
      emit();
    },
    handle(action, handler) {
      handlers.set(action, handler);
    },
    async act(id, action) {
      const handler = handlers.get(action);
      if (!handler) throw new Error(`${action} is not available for ${id}`);
      await handler(id);
    },
    track(id) {
      return ({ progress, log, to }) =>
        port.set(id, {
          state: progress ? RUNNING[progress.phase] : 'checking',
          progress,
          log: log || undefined,
          error: null,
          actions: [],
          ...(to ? { to } : {}),
        });
    },
    checked(id, patch = {}) {
      const reset = SETTLE.has(port.get(id).state)
        ? { state: 'current', progress: null, error: null, actions: [] }
        : {};
      port.set(id, { ...reset, checkedAt: now(), ...patch });
    },
    fail(id, error) {
      const item = port.get(id);
      const log = error.log ?? item.log ?? '';
      port.set(id, {
        state: 'failed',
        progress: null,
        checkedAt: now(),
        to: error.to ?? item.to,
        error: explain(item, error),
        log: log.includes(error.message) ? log : `${log}${log ? '\n' : ''}${error.message}`,
        actions: ['retry'],
      });
    },
  };
  if (developer) {
    port.developer = () => developerHandler?.on() ?? false;
    port.setDeveloper = async (on) => {
      if (!developerHandler) throw new Error('Developer mode is not available yet.');
      await developerHandler.set(on);
    };
  }
  return port;
}
