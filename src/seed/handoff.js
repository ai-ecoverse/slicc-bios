export const PREFIX = 'slicc-os.handoff.';
export const DROPPED = 'sliccDropped';
export const STALE_MS = 10 * 60 * 1000;
const ID = 'handoff';

const storageOf = (storage) => {
  try {
    return storage ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

function read(storage, id) {
  try {
    const kept = JSON.parse(storage?.getItem(`${PREFIX}${id}`) ?? 'null');
    const values = kept?.values;
    return values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  } catch {
    return {};
  }
}

function attempt(act) {
  try {
    act();
    return true;
  } catch {
    return false;
  }
}

function tidy(at, past, params) {
  if (!past?.replaceState) return;
  const rest = params.toString();
  past.replaceState(past.state, '', `${at.pathname}${at.search}${rest ? `#${rest}` : ''}`);
}

export function take(
  names,
  {
    location: at = globalThis.location,
    history: past = globalThis.history,
    storage,
    needs = null,
  } = {}
) {
  const store = storageOf(storage);
  const params = new URLSearchParams(at.hash.slice(1));
  const id = params.get(ID);
  const kept = id ? read(store, id) : {};
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
  if (stripped) tidy(at, past, params);
  if (id && store) {
    const key = `${PREFIX}${id}`;
    attempt(() =>
      Object.keys(kept).length
        ? store.setItem(key, JSON.stringify({ at: Date.now(), values: kept }))
        : store.removeItem(key)
    );
  }
  return found;
}

export function clearHandOff({
  location: at = globalThis.location,
  history: past = globalThis.history,
  storage,
  now = Date.now(),
} = {}) {
  const store = storageOf(storage);
  const params = new URLSearchParams(at?.hash?.slice(1) ?? '');
  const id = params.get(ID);
  if (id) {
    params.delete(ID);
    tidy(at, past, params);
  }
  if (!store) return false;
  return attempt(() => {
    if (id) store.removeItem(`${PREFIX}${id}`);
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      let at = 0;
      try {
        at = Number(JSON.parse(store.getItem(key))?.at) || 0;
      } catch {}
      if (now - at > STALE_MS) store.removeItem(key);
    }
  });
}

export function dropped(scope = globalThis) {
  const names = scope[DROPPED];
  return Array.isArray(names) && names.length ? names.map(String) : null;
}

export function droppedLine(names) {
  return `Seven couldn’t store the settings from the link (${names.join(', ')}). Allow site storage and open the link again.`;
}
