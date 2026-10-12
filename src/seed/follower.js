import { createKernelModel } from '@ai-ecoverse/slicc-spectrum/kernel';
import { confirm, surfaces } from '@ai-ecoverse/slicc-spectrum/ui';
import { createFollow, deviceName, hubClient, keepFollow, takeFollow } from './follow.js';
import { failure } from './link.js';
import { createNotices } from './notices.js';
import { createUpdates } from './updates.js';

export const layouts = {
  agents: { side: 'left', open: ['tablet', 'desktop'] },
  chat: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  terminal: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  settings: { side: 'center', open: [] },
};

export function followPort(
  follow,
  { reload = () => location.replace(new URL('../', location.href)) } = {}
) {
  return {
    on(type, listener) {
      if (type !== 'follow') return () => undefined;
      return follow.on(() => listener(follow.status()));
    },
    state: () => follow.status(),
    async leave() {
      await follow.leave();
      reload();
    },
    retry: () => follow.retry(),
  };
}

export function remoteKernel(follow) {
  return {
    openTerminal: () => Promise.reject(failure('EOPNOTSUPP: no terminals over this link yet')),
    follow,
  };
}

export const proxied = (at) => (at.hostname.endsWith('.sliccy.ai') ? at.origin : null);

export const ASK = {
  title: 'Follow a SLICC on another computer?',
  body: 'This tab, and every SLICC tab in this browser, then shows that SLICC’s chat and terminals instead of your own SLICC, until you choose Leave. Follow only a link you opened yourself.',
  action: 'Follow',
  cancel: 'Cancel',
  variant: 'confirmation',
};

export async function admitted(
  kept,
  {
    ask = confirm,
    storage = localStorage,
    leave = () => location.replace(new URL('../', location.href)),
  } = {}
) {
  if (!kept.fresh) return true;
  if (!(await ask(ASK))) {
    leave();
    return false;
  }
  keepFollow(kept, storage);
  return true;
}

export function startFollower({
  kept,
  app = document.querySelector('slicc-app'),
  root,
  storage = localStorage,
  origin = proxied(location),
  makePeer = (config) => new RTCPeerConnection(config),
  tab = crypto.randomUUID(),
  admit = async () => true,
}) {
  const follow = createFollow({
    kept,
    storage,
    post: hubClient({ origin, fetch: (...args) => fetch(...args) }),
    makePeer,
    hello: () => ({
      name: deviceName(),
      mode: 'remote',
      kind: 'seven',
      caps: ['join', 'permissions'],
      node: tab,
    }),
  });
  app.layoutKey = 'slicc-os.follow-layout';
  app.surfaces = Object.entries(layouts).map(([id, layout]) => ({
    ...surfaces.find((item) => item.id === id),
    ...layout,
  }));
  app.model = {
    ...createKernelModel({
      kernel: remoteKernel(follow),
      root,
      storage,
      terminals: { open: 0 },
    }),
    updates: createUpdates({ ready: true }),
    notices: createNotices({ storage }),
    follow: followPort(follow),
  };
  document.documentElement.dataset.follow = 'on';
  void admit().then((yes) => yes && follow.start());
  return follow;
}

const kept = takeFollow();
if (kept) {
  startFollower({
    kept,
    root: await navigator.storage.getDirectory(),
    admit: () => admitted(kept),
  });
}
