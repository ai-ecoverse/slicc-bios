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

const BASE = {
  'local-proxy': ({ proxy }) => `the local proxy at ${new URL(proxy.url).host}`,
  extension: () => 'slicc-extension',
  page: () => "this page's own fetch",
};

const STOPPED = {
  'local-proxy': ({ proxy }) =>
    `The local proxy at ${new URL(proxy.url).host} stopped answering: run npx @ai-ecoverse/slicc-node again, then Check again`,
  extension: () =>
    'slicc-extension stopped answering: check that it is still installed and enabled',
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
  if (!status) return null;
  return `${PROBLEM[status.state](new URL(proxy.url).host, status)}; using ${NAME[kind]}`;
}

function tailnetActions(tailnet) {
  if (!tailnet) return {};
  return {
    setTailnet: (on) => tailnet.setTailnet(on),
    setExitNode: (id) => tailnet.setExitNode(id),
    submitAuthKey: (key) => tailnet.submitAuthKey(key),
    logoutTailnet: () => tailnet.logoutTailnet(),
  };
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
    const stopped = fullWeb && failing && (state.status?.state ?? 'ready') === 'ready';
    const tailnet = options.tailnet?.status();
    const exit = tailnet?.state === 'running' && tailnet.exitNode;
    return {
      ...(exit
        ? {
            route: 'tailnet',
            health: 'ok',
            detail: `This computer's own services still go through ${BASE[state.kind](state)}.`,
          }
        : {
            route,
            health: !fullWeb ? 'limited' : failing ? 'failing' : 'ok',
            detail: stopped ? STOPPED[state.kind](state) : describe(state),
          }),
      failures,
      extensionUrl: EXTENSION_URL,
      ...(options.browser ? { browser: options.browser() } : {}),
      ...(tailnet ? { tailnet } : {}),
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
    ...tailnetActions(options.tailnet),
    async check() {
      if (options.tailnet?.status().state === 'failed') await options.tailnet.check();
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
  options.tailnet?.on(emit);
  return { port, transport };
}
