import { checkLocalProxy } from '@ai-ecoverse/slicc-kernel';
import { DIRECT } from './exits.js';
import { mergeDevices } from './link.js';

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

export const EXIT_KEY = 'slicc-os.exit';

export function currentExit(router, tailnet) {
  const chosen = router?.chosen();
  if (chosen?.startsWith('link:')) return { kind: 'link', id: chosen.slice(5) };
  const automatic = chosen === null ? router.defaultExit() : null;
  if (automatic?.kind === 'link') return { kind: 'link', id: automatic.id.slice(5) };
  if (tailnet?.state !== 'running' || !tailnet.exitNode) return null;
  if (tailnet.autoExitNode) return { kind: 'tailnet', node: 'auto' };
  const node = tailnet.exitNodes?.find((item) => item.name === tailnet.exitNode);
  return { kind: 'tailnet', node: node?.id ?? 'auto' };
}

function leaderActions(leaders, emit) {
  if (!leaders) return {};
  const act = (name) => async (id) => {
    await leaders[name](id);
    emit();
  };
  return {
    retryLeader: act('retry'),
    disconnectLeader: act('disconnect'),
    reconnectLeader: act('reconnect'),
    forgetLeader: act('forget'),
  };
}

function exitActions({ router, links, tray, pairing, tailnet, storage, linkedFolders }, emit) {
  if (!router || !links) return {};
  const remember = (id) => {
    if (id) storage.setItem(EXIT_KEY, id);
    else storage.removeItem(EXIT_KEY);
  };
  const clearTailnet = async () => {
    const status = tailnet?.status();
    if (status?.state === 'running' && status.exitNode) await tailnet.setExitNode(null);
  };
  const saved = storage.getItem(EXIT_KEY);
  if (saved?.startsWith('link:') || saved === DIRECT) router.choose(saved);
  return {
    async setExit(exit) {
      if (exit?.kind === 'link') {
        const device = links.devices().find((item) => item.id === exit.id);
        if (!device?.exit) throw new Error('That device doesn’t offer to be the exit.');
        await clearTailnet();
        router.choose(`link:${exit.id}`);
        remember(`link:${exit.id}`);
      } else {
        const direct = exit?.kind === 'tailnet' ? null : DIRECT;
        router.choose(direct);
        remember(direct);
        if (exit?.kind === 'tailnet') await tailnet.setExitNode(exit.node);
        else await clearTailnet();
      }
      emit();
    },
    async unlink(id) {
      if (pairing?.known(id)) await pairing.forget(id);
      else if (tray?.known(id)) await tray.forget(id);
      else links.drop(id, 'unlinked');
      if (router.chosen() === `link:${id}`) {
        router.choose(null);
        remember(null);
      }
      emit();
    },
    ...(linkedFolders
      ? {
          async mountFolder(source) {
            const target = await linkedFolders.mount(source);
            emit();
            return target;
          },
          async ejectFolder(source) {
            await linkedFolders.eject(source);
            emit();
          },
        }
      : {}),
    ...(tray
      ? {
          rotateJoinUrl: async () => {
            await tray.rotate();
            emit();
          },
          retryLinks: async () => {
            tray.stop();
            tray.start();
            pairing?.wake();
          },
          stopLinks: async () => {
            tray.stop();
            emit();
          },
          setRemoteControl: async (id, allowed) => {
            await tray.setControl(id, allowed);
            emit();
          },
          setAccess: async (id, name, allowed) => {
            await tray.setAccess(id, name, allowed);
            emit();
          },
        }
      : {}),
    ...(pairing ? pairingActions(pairing, emit, tray) : {}),
  };
}

function pairingActions(pairing, emit, tray) {
  return {
    pairComputer: async (url, options) => {
      await pairing.begin(url, options);
      emit();
    },
    confirmPairing: async () => {
      await pairing.confirm();
      emit();
    },
    cancelPairing: async () => {
      await pairing.cancel();
      emit();
    },
    ...(tray ? {} : { retryLinks: async () => pairing.wake() }),
  };
}

export function distinct(devices) {
  const counts = new Map();
  for (const item of devices) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  return devices.map((item) =>
    item.kind === 'seven' && counts.get(item.name) > 1
      ? { ...item, name: `${item.name} · ${item.id.slice(0, 4)}` }
      : item
  );
}

export function createNetwork(choice, options = {}) {
  const probe = options.check ?? checkLocalProxy;
  const reload = options.reload ?? (() => location.reload());
  const now = options.now ?? Date.now;
  const listeners = new Set();
  let failures = [];
  let failing = false;
  let state = choice;
  const away = () => [...(options.tray?.away() ?? []), ...(options.pairing?.away() ?? [])];

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
      ...linkStatus(),
      ...viaLink(),
      ...(options.leaders ? { leaders: options.leaders.status() } : {}),
    };
  };
  const viaLink = () => {
    const exit = options.router ? currentExit(options.router, null) : null;
    if (exit?.kind !== 'link' || !options.links) return {};
    const { id } = exit;
    const devices = [...options.links.devices(), ...away()];
    const connected = devices.some((item) => item.id === id && item.state === 'connected');
    return { route: 'link', health: connected ? 'ok' : 'failing', detail: null };
  };
  const linkStatus = () => {
    if (!options.links || !options.router) return {};
    const devices = distinct(mergeDevices([...options.links.devices(), ...away()]));
    const exit = currentExit(options.router, options.tailnet?.status());
    const sync = options.tray?.status() ?? {};
    const { joinUrl = null, joinCommand = null, webhookUrl = null, followUrl } = sync;
    const { pairing } = options;
    return {
      exit,
      ...(devices.length || options.tray || pairing
        ? {
            links: {
              ...(options.tray ? { joinUrl, joinCommand } : {}),
              ...(followUrl !== undefined ? { followUrl } : {}),
              devices,
              permission: pairing?.permission() ?? null,
              webhookUrl,
              ...(options.tray ? { sync: sync.state } : {}),
              ...(pairing ? { pairing: pairing.status() } : {}),
            },
          }
        : {}),
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
    ...leaderActions(options.leaders, () => emit()),
    ...exitActions({ ...options, storage: options.storage ?? globalThis.localStorage }, () =>
      emit()
    ),
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
  options.links?.on(emit);
  options.tray?.on(emit);
  options.pairing?.on(emit);
  options.leaders?.on(emit);
  return { port, transport };
}
