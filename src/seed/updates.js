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

export function createUpdates({ ready = false, now = Date.now } = {}) {
  const listeners = new Set();
  const handlers = new Map();
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
  const emit = () => {
    for (const listener of [...listeners]) listener(items);
  };
  const port = {
    on(type, listener) {
      if (type !== 'items') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => items,
    ready: () => ready,
    get: (id) => items.find((item) => item.id === id),
    set(id, patch) {
      items = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
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
      return ({ progress, log }) =>
        port.set(id, {
          state: progress ? RUNNING[progress.phase] : 'checking',
          progress,
          log: log || undefined,
          error: null,
          actions: [],
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
  return port;
}
