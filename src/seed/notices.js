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

export const WAITING = 'sw-waiting';
export const SETTLE_MS = 10000;
export const POLL_MS = 2000;

export function ownStreams(container = navigator.serviceWorker, ms = 2000) {
  const controller = container?.controller;
  if (!controller) return Promise.resolve([]);
  return new Promise((resolve) => {
    const done = (list) => {
      clearTimeout(timer);
      container.removeEventListener('message', listen);
      resolve(list);
    };
    const listen = ({ data }) => {
      if (Array.isArray(data?.streams)) done(data.streams.map(({ url }) => url));
    };
    const timer = setTimeout(() => done([]), ms);
    container.addEventListener('message', listen);
    controller.postMessage({ streams: 'mine' });
  });
}

function shown(href, origin) {
  const url = new URL(href);
  return url.origin === origin ? url.pathname : `${url.host}${url.pathname}`;
}

export function waitingNotice({ here, others, origin }) {
  const body = here.length
    ? `This tab is still loading ${shown(here[0], origin)} with the old version. Reload to apply the update; that load stops.`
    : others.length
      ? `Another seven tab is still loading ${shown(others[0], origin)} with the old version. Close or reload that tab to apply the update.`
      : 'Reload to apply the update.';
  return {
    tone: 'info',
    title: 'Seven updated',
    body,
    actions: here.length || !others.length ? [{ id: 'reload', label: 'Reload' }] : [],
  };
}

export function watchWaiting({
  registration,
  board,
  notices,
  reload,
  streams = ownStreams,
  origin = location.origin,
  every = setInterval,
  now = Date.now,
  settle = SETTLE_MS,
  poll = POLL_MS,
}) {
  let worker = null;
  let since = null;
  let mine = [];
  let holders = [];
  let showing = null;
  const owning = () => board.owner()?.tab === board.id;
  const held = () => since !== null && now() - since >= settle;
  const hide = () => {
    if (showing) notices.remove(showing);
    showing = null;
  };
  const render = () => {
    if (!held() || !owning()) return hide();
    const others = holders.filter(({ tab }) => tab !== board.id).flatMap(({ holds }) => holds);
    const id = `${WAITING}:${since}`;
    if (showing && showing !== id) hide();
    showing = id;
    notices.show({ id, ...waitingNotice({ here: mine, others, origin }) }, (action) => {
      if (action === 'reload') reload();
    });
  };
  const report = (list) => {
    if (list.length === mine.length && list.every((url, i) => url === mine[i])) return;
    mine = list;
    board.hold(list);
  };
  board.on('holders', (list) => {
    holders = list;
    render();
  });
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const waiting = registration.waiting;
      if (waiting !== worker) {
        worker = waiting;
        since = waiting ? now() : null;
      }
      report(held() ? await streams() : []);
      render();
    } finally {
      busy = false;
    }
  };
  every(() => void tick(), poll);
  return { tick };
}
