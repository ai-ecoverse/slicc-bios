import { createKernel, fetchTransport } from '@ai-ecoverse/slicc-kernel';
import { createKernelModel } from '@ai-ecoverse/slicc-spectrum/kernel';
import { confirm, surfaces } from '@ai-ecoverse/slicc-spectrum/ui';
import { followAgent, installAgent, loadChat } from './agent.js';
import { createFollow, deviceName, hubClient, keepFollow, takeFollow } from './follow.js';
import { createNotices } from './notices.js';
import { joinTray } from './present.js';
import { remoteTerminal } from './terminal.js';
import { createUpdates } from './updates.js';

export const layouts = {
  agents: { side: 'left', open: ['tablet', 'desktop'] },
  chat: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  terminal: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  network: { side: 'right', open: [] },
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

const CONNECTION = {
  connecting: 'connecting',
  connected: 'live',
  reconnecting: 'reconnecting',
  failed: 'error',
  unlinked: 'offline',
};

export function followTray(follow, port) {
  const status = () => {
    const state = follow.status();
    return {
      name: state.owner,
      kind: 'hosted',
      connection: CONNECTION[state.link] ?? 'offline',
      role: 'follower',
      followers: [],
      joinUrl: '',
    };
  };
  return {
    on(type, listener) {
      if (type !== 'status') return () => undefined;
      return follow.on(() => listener(status()));
    },
    status,
    reconnect: () => void follow.retry(),
    disconnect: () => void port.leave(),
  };
}

export function remoteKernel(follow) {
  return {
    openTerminal: (_argv, options) => remoteTerminal((meta) => follow.open(meta), options),
    follow,
  };
}

export const RETRY_MS = 2_000;

export const OTHER_VERSION = 'follow:other-agent-version';

export function agentFollower({
  follow,
  show,
  prepare = async () => undefined,
  connect = (open) => followAgent(open),
  create = async (connection) => (await loadChat()).createAgentModel(connection, {}),
  notices = null,
  timers = globalThis,
}) {
  let connection = null;
  let session = null;
  let busy = false;
  let again = false;
  let retry = null;
  let refused = null;
  const refuse = (current, error) => {
    refused = current;
    timers.clearTimeout(retry);
    notices?.show(
      {
        id: OTHER_VERSION,
        tone: 'warning',
        title: 'This tab can’t follow that SLICC',
        body: error.message,
        actions: [],
        dismissible: false,
      },
      () => {}
    );
  };
  const drop = () => {
    const old = connection;
    connection = null;
    session = null;
    show(null);
    void old?.close().catch(() => undefined);
  };
  const later = () => {
    timers.clearTimeout(retry);
    retry = timers.setTimeout(sync, RETRY_MS);
  };
  const fresh = (current) => follow.session() === current && follow.status().access.view;
  async function join(current) {
    await prepare();
    const joined = await connect((meta) => follow.open(meta));
    let agent = null;
    try {
      agent = fresh(current) ? await create(joined) : null;
    } catch (error) {
      void joined.close().catch(() => undefined);
      throw error;
    }
    if (!agent || !fresh(current)) {
      void joined.close().catch(() => undefined);
      return;
    }
    connection = joined;
    session = current;
    notices?.remove(OTHER_VERSION);
    show(agent);
    void joined.closed.then(() => {
      if (connection !== joined) return;
      drop();
      later();
    });
  }
  async function sync() {
    const current = follow.session();
    const { view } = follow.status().access;
    if (connection && (!view || current !== session)) drop();
    if (busy) again = true;
    if (!current || !view || connection || busy || current === refused) return;
    busy = true;
    try {
      await join(current);
    } catch (error) {
      console.warn(`following the agent: ${error.message}`);
      if (error?.code === 'EVERSION') refuse(current, error);
      else later();
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      await sync();
    }
  }
  follow.on(() => void sync());
  return { sync, connection: () => connection };
}

export function preparer(root, { install = installAgent } = {}) {
  let prepared = null;
  return () => {
    prepared ??= install(() =>
      createKernel({ root, users: 'off', network: { transport: fetchTransport() }, media: false })
    ).catch((error) => {
      prepared = null;
      throw error;
    });
    return prepared;
  };
}

export const shower = (app, base) => (agent) => {
  app.model = agent ? { ...base, ...agent, tray: joinTray(agent.tray, base.tray) } : base;
};

export const chatModel =
  (storage, notices, load = loadChat) =>
  async (connection) =>
    (await load()).createAgentModel(connection, { storage, notices });

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
  const port = followPort(follow);
  const base = {
    ...createKernelModel({
      kernel: remoteKernel(follow),
      root,
      storage,
      terminals: { open: 0 },
    }),
    updates: createUpdates({ ready: true }),
    notices: createNotices({ storage }),
    follow: port,
    tray: followTray(follow, port),
  };
  app.model = base;
  agentFollower({
    follow,
    show: shower(app, base),
    prepare: preparer(root),
    create: chatModel(storage, base.notices),
    notices: base.notices,
  });
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
