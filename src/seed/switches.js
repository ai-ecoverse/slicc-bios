export const SWITCHES_KEY = 'slicc-os.switches';

export const switchedOff = (what) => `${what} capture is off in seven's settings`;

export function createSwitches({
  storage = globalThis.localStorage,
  key = SWITCHES_KEY,
  events = globalThis,
} = {}) {
  const added = new Map();
  const listeners = new Set();
  const read = () => {
    try {
      const stored = JSON.parse(storage.getItem(key) ?? '{}');
      return stored && typeof stored === 'object' ? stored : {};
    } catch {
      return {};
    }
  };
  let stored = read();
  const on = (name) => stored[name] !== false;
  const list = () => [...added].map(([name, { label }]) => ({ key: name, label, on: on(name) }));
  const emit = () => {
    const now = list();
    for (const listener of [...listeners]) listener(now);
  };
  const turned = (before) => {
    for (const [name, entry] of added) if (before[name] !== false && !on(name)) entry.off();
  };
  events.addEventListener?.('storage', (event) => {
    if (event.key !== key) return;
    const before = stored;
    stored = read();
    turned(before);
    emit();
  });
  return {
    port: {
      list,
      set(name, value) {
        if (!added.has(name)) return;
        const before = stored;
        stored = { ...stored };
        if (value) delete stored[name];
        else stored[name] = false;
        storage.setItem(key, JSON.stringify(stored));
        turned(before);
        emit();
      },
      on(type, listener) {
        if (type !== 'switches') return () => undefined;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    add({ key: name, label, off = () => {} }) {
      added.set(name, { label, off });
      emit();
      return { on: () => on(name) };
    },
  };
}
