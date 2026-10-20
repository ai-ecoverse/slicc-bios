const DISMISSED = 'slicc-os.notices.dismissed';

export function createNotices({ storage = localStorage } = {}) {
  const listeners = new Set();
  const handlers = new Map();
  let notices = [];
  const session = new Set();
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
  const drop = (id) => {
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
      if (session.has(notice.id) || dismissed().has(notice.id)) return false;
      const at = notices.findIndex((item) => item.id === notice.id);
      notices = at < 0 ? [...notices, notice] : notices.with(at, notice);
      handlers.set(notice.id, handler);
      emit();
      return true;
    },
    remove(id) {
      session.delete(id);
      drop(id);
    },
    async act(id, action) {
      const handler = handlers.get(id);
      if (!handler) throw new Error('This notice is gone.');
      await handler(action);
    },
    dismiss(id) {
      if (notices.find((notice) => notice.id === id)?.session) session.add(id);
      else storage.setItem(DISMISSED, JSON.stringify([...dismissed(), id]));
      drop(id);
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

export const NO_SENDING = 'You can send messages once the agent starts.';

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
  return { ...source, hold: (on) => take(on ? NO_SENDING : null) };
}

export function mirrorHold(os) {
  const { take, ...source } = lines();
  os.on('held', take);
  void os.call('held').then(take, () => undefined);
  return source;
}

export function heldAgent(agent, source) {
  return new Proxy(agent, {
    get(target, key) {
      if (key === 'readOnly') return () => source.held();
      if (key === 'on')
        return (type, listener) =>
          type === 'readOnly' ? source.on(listener) : target.on(type, listener);
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
