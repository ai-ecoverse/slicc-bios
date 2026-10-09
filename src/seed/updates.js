export const components = [
  ['agent', 'agent', 'Agent (/opt/agent)'],
  ['kernel', 'kernel', 'Kernel'],
  ['ui', 'ui', 'UI'],
  ['bios', 'bios', 'BIOS packages'],
  ['grammars', 'grammars', 'Syntax grammars'],
];

export const owners = {
  kernel: '@ai-ecoverse/slicc-kernel',
  ui: '@ai-ecoverse/slicc-spectrum',
};

const RUNNING = { download: 'downloading', link: 'linking' };
const SETTLE = new Set(['checking', 'downloading', 'linking', 'failed']);

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
      port.set(id, {
        state: 'failed',
        progress: null,
        checkedAt: now(),
        error: error.message,
        log: error.log ?? port.get(id).log,
        actions: ['retry'],
      });
    },
  };
  return port;
}
