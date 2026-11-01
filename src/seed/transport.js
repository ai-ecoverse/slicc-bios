import { fetchTransport } from '@ai-ecoverse/slicc-kernel';
import { redirectMode } from './redirects.js';

export const EXTENSION_REDIRECT_MINIMUM = '7.11.0';
export const EXTENSION_UPDATE_HINT =
  'update slicc-extension before using manual redirects or credentialed requests';

export function extensionRedirects(version, minimum = EXTENSION_REDIRECT_MINIMUM) {
  const parts = (value) =>
    /^\d+\.\d+\.\d+$/.test(value ?? '') ? value.split('.').map(Number) : null;
  const actual = parts(version);
  const wanted = parts(minimum);
  if (!actual || !wanted || [...actual, ...wanted].some((n) => !Number.isSafeInteger(n)))
    return false;
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] !== wanted[i]) return actual[i] > wanted[i];
  }
  return true;
}

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

function redirectingTransport(options) {
  const transport = fetchTransport(options);
  return {
    ...transport,
    fetch: (request) =>
      fetchTransport({
        ...options,
        redirect: redirectMode(request, options.redirect ?? 'follow'),
      }).fetch(request),
  };
}

export async function pickTransport({ minimumRedirectVersion = EXTENSION_REDIRECT_MINIMUM } = {}) {
  await stored('readwrite', (store) => store.delete('proxy')).catch(() => undefined);
  const extension = globalThis.sliccExtension;
  if (extension) {
    const supported = extensionRedirects(extension.version, minimumRedirectVersion);
    const send = (input, init) => extension.fetch(input, init);
    const transport = redirectingTransport({ fetch: send, bodyIdleMs: BODY_IDLE_MS });
    const manual = supported
      ? redirectingTransport({ fetch: send, bodyIdleMs: BODY_IDLE_MS, redirect: 'manual' })
      : null;
    return {
      kind: 'extension',
      transport: {
        ...transport,
        traits: { ...transport.traits, crossOrigin: 'any' },
        fetch: (request) => {
          if (redirectMode(request) !== 'follow' && !supported)
            return Promise.reject(
              Object.assign(new TypeError(EXTENSION_UPDATE_HINT), { code: 'EACCES', status: 502 })
            );
          return transport.fetch(request);
        },
      },
      credentialed: manual && { ...manual, active: () => globalThis.sliccExtension === extension },
    };
  }
  const fetch = withoutUserAgent();
  return {
    kind: 'page',
    transport: redirectingTransport({ fetch, hint: HINT, bodyIdleMs: BODY_IDLE_MS }),
    credentialed: {
      ...redirectingTransport({ fetch, hint: HINT, bodyIdleMs: BODY_IDLE_MS, redirect: 'manual' }),
      active: () => true,
    },
  };
}
