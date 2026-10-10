import { checkLocalProxy, fetchTransport, localProxyTransport } from '@ai-ecoverse/slicc-kernel';

const DATABASE = 'slicc-os';
const STORE = 'transport';
const PROXY = 'proxy';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BODY_IDLE_MS = 30000;
export const HINT = 'for the whole web, run npx @ai-ecoverse/slicc-node or install slicc-extension';

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname) && parsed.origin === url;
  } catch {
    return false;
  }
}

export function takeFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('proxy') && !params.has('key')) return null;
  const url = params.get('proxy');
  const key = params.get('key');
  params.delete('proxy');
  params.delete('key');
  const rest = params.toString();
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`
  );
  return key && isLoopback(url) ? { url, key } : null;
}

function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

export async function stored(mode, act) {
  const opening = indexedDB.open(DATABASE, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  const db = await request(opening);
  try {
    return await request(act(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

export async function pickTransport() {
  const given = takeFragment();
  if (given) await stored('readwrite', (store) => store.put(given, PROXY));
  const proxy = given ?? (await stored('readonly', (store) => store.get(PROXY)));
  const status = proxy ? await checkLocalProxy(proxy) : undefined;
  if (status?.state === 'ready') {
    return {
      kind: 'local-proxy',
      transport: localProxyTransport({ ...proxy, bodyIdleMs: BODY_IDLE_MS }),
      proxy,
      status,
    };
  }
  const kept = status?.state === 'blocked' || status?.permission === 'prompt';
  if (status && !kept) await stored('readwrite', (store) => store.delete(PROXY));
  const extension = globalThis.sliccExtension;
  if (extension) {
    return {
      kind: 'extension',
      transport: fetchTransport({ fetch: extension.fetch, bodyIdleMs: BODY_IDLE_MS }),
      proxy,
      status,
    };
  }
  return {
    kind: 'page',
    transport: fetchTransport({ hint: HINT, bodyIdleMs: BODY_IDLE_MS }),
    proxy,
    status,
  };
}
