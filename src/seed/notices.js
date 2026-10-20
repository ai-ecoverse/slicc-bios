const DISMISSED = 'slicc-os.notices.dismissed';

export function createNotices({ storage = localStorage } = {}) {
  const listeners = new Set();
  const handlers = new Map();
  let notices = [];
  const dismissed = () => {
    try {
      return new Set(JSON.parse(storage.getItem(DISMISSED) ?? '[]'));
    } catch {
      return new Set();
    }
  };
  const emit = () => {
    for (const listener of [...listeners]) listener(notices);
  };
  const remove = (id) => {
    if (!notices.some((notice) => notice.id === id)) return;
    notices = notices.filter((notice) => notice.id !== id);
    handlers.delete(id);
    emit();
  };
  return {
    on(type, listener) {
      if (type !== 'notices') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => notices,
    show(notice, handler) {
      if (dismissed().has(notice.id)) return false;
      const at = notices.findIndex((item) => item.id === notice.id);
      notices = at < 0 ? [...notices, notice] : notices.with(at, notice);
      handlers.set(notice.id, handler);
      emit();
      return true;
    },
    remove,
    async act(id, action) {
      const handler = handlers.get(id);
      if (!handler) throw new Error('This notice is gone.');
      await handler(action);
    },
    dismiss(id) {
      storage.setItem(DISMISSED, JSON.stringify([...dismissed(), id]));
      remove(id);
    },
  };
}

export function agentInstalling(from, to) {
  return {
    id: `agent:installing:${to}`,
    tone: 'info',
    title: from ? 'Seven is updating its agent' : 'Seven is installing its agent',
    body: `The chat starts once agent ${to} is installed.`,
    actions: [{ id: 'show-updates', label: 'Open Install / Update' }],
  };
}

export const startingLine = (from) =>
  from ? 'Seven is updating its agent.' : 'Seven is installing its agent.';

export const RELOAD_FIRST = 'Reload this tab to reach the new agent.';

function lines() {
  const listeners = new Set();
  let line = null;
  return {
    held: () => line,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    take(next) {
      if (next === line) return;
      line = next;
      for (const listener of [...listeners]) listener(line);
    },
  };
}

export function holdComposer() {
  const { take, ...source } = lines();
  return { ...source, hold: (line) => take(line) };
}

export function mirrorHold(os, tabs) {
  const listeners = new Set();
  let held = null;
  let shown = null;
  let off = null;
  const line = () => (held && tabs.state().skew ? RELOAD_FIRST : held);
  const settle = () => {
    const next = line();
    if (next === shown) return;
    shown = next;
    for (const listener of [...listeners]) listener(next);
  };
  const heard = (next) => {
    held = next;
    settle();
  };
  os.on('held', heard);
  void os.call('held').then(heard, () => undefined);
  return {
    held: line,
    on(listener) {
      if (!off) {
        shown = line();
        off = tabs.on('tabs', settle);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size || !off) return;
        off();
        off = null;
      };
    },
  };
}

export function heldAgent(agent, source) {
  return new Proxy(agent, {
    get(target, key) {
      if (key === 'starting') return () => source.held();
      if (key === 'on')
        return (type, listener) =>
          type === 'starting' ? source.on(listener) : target.on(type, listener);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const REPAIRED = 'slicc-bios.repaired';

export function reportRepairs(notices, storage = localStorage) {
  const paths = JSON.parse(storage.getItem(REPAIRED) ?? '[]');
  storage.removeItem(REPAIRED);
  if (!paths.length) return false;
  const what =
    paths.length === 1
      ? `Seven’s file ${paths[0]} changed after seven installed it.`
      : `${paths.length} of seven’s files, such as ${paths[0]}, changed after seven installed them.`;
  return notices.show(
    {
      id: `repaired:${Date.now()}`,
      tone: 'warning',
      title: 'Seven’s files were changed',
      body: `${what} Seven didn’t run the changed code and put back the files it installed.`,
      actions: [],
    },
    () => {}
  );
}

export const STOPPED = 'slicc-bios.stopped';

export function reportStopped(notices, storage = localStorage, worker = navigator.serviceWorker) {
  const show = (path) =>
    notices.show(
      {
        id: `stopped:${path}`,
        tone: 'warning',
        title: 'Seven stopped restoring a file',
        body: `Seven keeps finding ${path} changed. It stopped restoring it and won’t run it. Something on this computer may be changing seven’s files.`,
        actions: [],
      },
      () => {}
    );
  const known = () => JSON.parse(storage.getItem(STOPPED) ?? '[]');
  worker?.addEventListener('message', ({ data }) => {
    const path = data?.integrity?.stopped;
    if (!path) return;
    storage.setItem(STOPPED, JSON.stringify([...new Set([...known(), path])]));
    show(path);
  });
  for (const path of known()) show(path);
}
