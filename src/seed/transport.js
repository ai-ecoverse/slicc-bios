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

export const FORBIDDEN_HEADER = 'forbidden-header';
export const EXTENSION_HEADERS = new Set(['cookie', 'origin', 'referer', 'user-agent']);
export const EXTENSION_HEADER_HINT = 'link a slicc CLI (npx sliccy@next), which sends every header';
const HTTP_OWN = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const PROBE = 'http://forbidden-headers.invalid/';

export function unsendable(headers, sends) {
  const given = new Headers();
  for (const [name, value] of headers ?? []) {
    try {
      given.append(name, value);
    } catch {}
  }
  const kept = new Request(PROBE, { headers: given }).headers;
  return [...new Set(given.keys())].filter(
    (name) => !kept.has(name) && !sends.has(name) && !HTTP_OWN.has(name)
  );
}

export function refusal(url, names, who, hint) {
  const which = names.length > 1 ? 'headers' : 'header';
  return Object.assign(
    new Error(
      `fetch ${url} refused: ${who} can't send the request ${which} ${names.join(', ')}, so it was not sent${hint ? `: ${hint}` : ''}`
    ),
    { status: 502, code: 'ENOTSUP', detail: FORBIDDEN_HEADER, headers: [...names] }
  );
}

export function sendsOnly(transport, sends, who, hint) {
  return {
    ...transport,
    async fetch(request) {
      const names = unsendable(request.headers, sends);
      if (names.length > 0) throw refusal(request.url, names, who, hint);
      return transport.fetch(request);
    },
  };
}

export function withoutUserAgent(transport) {
  return {
    ...transport,
    fetch: (request) =>
      transport.fetch({
        ...request,
        headers: [...(request.headers ?? [])].filter(
          ([name]) => String(name).toLowerCase() !== 'user-agent'
        ),
      }),
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
    const declared = (options) =>
      sendsOnly(
        redirectingTransport({ fetch: send, bodyIdleMs: BODY_IDLE_MS, ...options }),
        EXTENSION_HEADERS,
        'slicc-extension',
        EXTENSION_HEADER_HINT
      );
    const transport = declared({});
    const manual = supported ? declared({ redirect: 'manual' }) : null;
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
  const page = {
    fetch: globalThis.fetch.bind(globalThis),
    hint: HINT,
    bodyIdleMs: BODY_IDLE_MS,
    forbiddenHeaders: 'refuse',
  };
  return {
    kind: 'page',
    transport: withoutUserAgent(redirectingTransport(page)),
    credentialed: {
      ...withoutUserAgent(redirectingTransport({ ...page, redirect: 'manual' })),
      active: () => true,
    },
  };
}
