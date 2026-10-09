import { checkLocalProxy } from '@ai-ecoverse/slicc-kernel';

export const EXTENSION_URL =
  'https://chromewebstore.google.com/detail/slicc/akjjllgokmbgpbdbmafpiefnhidlmbgf';
const FAILURES = 20;

const ROUTE = {
  'local-proxy': 'proxy',
  extension: 'extension',
  page: 'page',
};

const NAME = {
  extension: 'slicc-extension',
  page: 'the page fetch, limited by CORS',
};

const ALONE = {
  extension: 'Through slicc-extension',
  page: 'The page fetch, limited by CORS',
};

const PROBLEM = {
  blocked: (at) =>
    `Local proxy at ${at} is blocked: allow this site to access apps on this device in Chrome's site settings`,
  unreachable: (at, status) =>
    status.permission === 'prompt'
      ? `No answer from the local proxy at ${at}: allow access to apps on this device if Chrome asks, or run npx @ai-ecoverse/slicc-node again`
      : `No local proxy at ${at}: run npx @ai-ecoverse/slicc-node again`,
  refused: (at, status) =>
    `Local proxy at ${at} refused this page (${status.error}): open SLICC from the launcher again`,
  incompatible: (at) => `${at} is not a SLICC local proxy`,
};

export function describe({ kind, proxy, status }) {
  if (kind === 'local-proxy') {
    if (status?.state && status.state !== 'ready') {
      return PROBLEM[status.state](new URL(proxy.url).host, status);
    }
    return `Local proxy at ${new URL(proxy.url).host}`;
  }
  if (!status) return ALONE[kind];
  return `${PROBLEM[status.state](new URL(proxy.url).host, status)}; using ${NAME[kind]}`;
}

export function createNetwork(choice, options = {}) {
  const probe = options.check ?? checkLocalProxy;
  const reload = options.reload ?? (() => location.reload());
  const now = options.now ?? Date.now;
  const listeners = new Set();
  let failures = [];
  let failing = false;
  let state = choice;

  const status = () => {
    const route = ROUTE[state.kind];
    const fullWeb = route === 'proxy' || route === 'extension';
    return {
      route,
      health: !fullWeb ? 'limited' : failing ? 'failing' : 'ok',
      detail: describe(state),
      failures,
      extensionUrl: EXTENSION_URL,
    };
  };
  const emit = () => {
    const current = status();
    for (const listener of [...listeners]) listener(current);
  };

  const transport = {
    ...choice.transport,
    async fetch(request) {
      try {
        const response = await choice.transport.fetch(request);
        if (failing) {
          failing = false;
          emit();
        }
        return response;
      } catch (error) {
        if (!request.signal?.aborted) {
          failures = [{ url: request.url, error: error.message, at: now() }, ...failures].slice(
            0,
            FAILURES
          );
          failing = true;
          emit();
        }
        throw error;
      }
    },
  };

  const port = {
    on(type, listener) {
      if (type !== 'network') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status,
    async check() {
      if (!choice.proxy) {
        emit();
        return;
      }
      const checked = await probe(choice.proxy);
      if (checked.state === 'ready' && choice.kind !== 'local-proxy') {
        location.hash = new URLSearchParams({
          proxy: choice.proxy.url,
          key: choice.proxy.key,
        }).toString();
        reload();
        return;
      }
      state = { ...choice, status: checked };
      failing = checked.state !== 'ready';
      emit();
    },
  };
  return { port, transport };
}
