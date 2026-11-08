export const LIVE_CHANNEL = 'slicc-live';

export function tabList({
  channel,
  tab = crypto.randomUUID(),
  events = globalThis,
  act = () => {},
  heard = () => {},
}) {
  let mine = [];
  const theirs = new Map();
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const publish = (extra = {}) => channel.postMessage({ from: tab, list: mine, ...extra });
  channel.onmessage = ({ data }) => {
    if (data?.hello) publish();
    else if (data?.to === tab && typeof data.act === 'string') act(data.act);
    else if (typeof data?.from === 'string' && data.from !== tab && Array.isArray(data.list)) {
      const before = theirs.get(data.from) ?? [];
      if (data.list.length) theirs.set(data.from, data.list);
      else theirs.delete(data.from);
      heard(data, before);
      emit();
    }
  };
  events.addEventListener?.('pagehide', () => channel.postMessage({ from: tab, list: [] }));
  channel.postMessage({ hello: true });
  return {
    tab,
    set(list, extra) {
      mine = list;
      publish(extra);
      emit();
    },
    mine: () => mine,
    theirs: () => [...theirs.values()].flat(),
    holder: (id) =>
      [...theirs].find(([, list]) => list.some((item) => item.id === id))?.[0] ?? null,
    send: (to, id) => channel.postMessage({ to, act: id }),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createLive({
  channel = new BroadcastChannel(LIVE_CHANNEL),
  tab,
  events,
  now = Date.now,
} = {}) {
  const runs = new Map();
  const listeners = new Set();
  let count = 0;
  const shared = tabList({ channel, tab, events, act: (id) => runs.get(id)?.() });
  const items = () => [...shared.mine(), ...shared.theirs()];
  shared.on(() => {
    const list = items();
    for (const listener of [...listeners]) listener(list);
  });
  return {
    port: {
      items,
      act(id) {
        if (runs.has(id)) return runs.get(id)();
        const holder = shared.holder(id);
        if (holder) shared.send(holder, id);
      },
      on(type, listener) {
        if (type !== 'items') return () => undefined;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    add({ kind, label, what = '', asker, since = now(), action }) {
      count += 1;
      const id = `live:${shared.tab}:${count}`;
      runs.set(id, action.run);
      shared.set([
        ...shared.mine(),
        { id, kind, label, what, asker, since, action: { label: action.label } },
      ]);
      return () => {
        if (!runs.delete(id)) return;
        shared.set(shared.mine().filter((item) => item.id !== id));
      };
    },
  };
}
