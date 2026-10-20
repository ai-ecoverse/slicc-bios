export const HANDOFF = 'slicc-os.handoff';

const storageOf = (storage) => {
  try {
    return storage ?? globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

function read(storage) {
  try {
    const kept = JSON.parse(storage?.getItem(HANDOFF) ?? 'null');
    return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
  } catch {
    return {};
  }
}

function write(storage, kept) {
  if (!storage) return;
  if (Object.keys(kept).length) storage.setItem(HANDOFF, JSON.stringify(kept));
  else storage.removeItem(HANDOFF);
}

export function handOff(values, { storage } = {}) {
  const store = storageOf(storage);
  if (!store) return false;
  write(store, { ...read(store), ...values });
  return true;
}

export function take(
  names,
  { location: at = location, history: past = history, storage, needs = null } = {}
) {
  const store = storageOf(storage);
  const kept = read(store);
  const params = new URLSearchParams(at.hash.slice(1));
  if (needs && typeof kept[needs] !== 'string' && !params.has(needs)) return {};
  const found = {};
  for (const name of names) {
    if (typeof kept[name] === 'string') found[name] = kept[name];
    delete kept[name];
  }
  let stripped = false;
  for (const name of names) {
    if (!params.has(name)) continue;
    found[name] = params.get(name);
    params.delete(name);
    stripped = true;
  }
  if (stripped) {
    const rest = params.toString();
    past.replaceState(past.state, '', `${at.pathname}${at.search}${rest ? `#${rest}` : ''}`);
  }
  if (store) write(store, kept);
  return found;
}
