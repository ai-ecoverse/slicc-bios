import { fetchTransport } from '@ai-ecoverse/slicc-kernel';

const DATABASE = 'slicc-os';
const STORE = 'transport';
const BODY_IDLE_MS = 120000;
export const HINT = 'for the whole web, run npx sliccy@next or install slicc-extension';

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

export function withoutUserAgent(send = globalThis.fetch.bind(globalThis)) {
  return (url, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('user-agent');
    return send(url, { ...init, headers });
  };
}

export async function pickTransport() {
  await stored('readwrite', (store) => store.delete('proxy')).catch(() => undefined);
  const extension = globalThis.sliccExtension;
  if (extension) {
    const transport = fetchTransport({ fetch: extension.fetch, bodyIdleMs: BODY_IDLE_MS });
    return {
      kind: 'extension',
      transport: { ...transport, traits: { ...transport.traits, crossOrigin: 'any' } },
    };
  }
  return {
    kind: 'page',
    transport: fetchTransport({
      fetch: withoutUserAgent(),
      hint: HINT,
      bodyIdleMs: BODY_IDLE_MS,
    }),
  };
}
