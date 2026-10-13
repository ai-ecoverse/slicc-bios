import { attachKernel, createKernel, serveHostfsPort } from '@ai-ecoverse/slicc-kernel';
import { createKernelModel } from '@ai-ecoverse/slicc-spectrum/kernel';
import { confirm, surfaces } from '@ai-ecoverse/slicc-spectrum/ui';
import { signIn } from './adobe.js';
import {
  installed as agentInstalled,
  project as agentProject,
  version as agentVersion,
  bridgeAgent,
  deliverWebhook,
  installAgent,
  loadChat,
  recorded,
  remoteAgent,
  restartChat,
  startChat,
  whenIdle,
} from './agent.js';
import { createBrowser } from './browser.js';
import { browserControl } from './cdp.js';
import { createExitRouter } from './exits.js';
import { deviceName } from './follow.js';
import { createFollowers } from './followers.js';
import {
  grammarBase,
  grammars,
  project as grammarsProject,
  version as grammarsVersion,
  installed,
} from './grammars.js';
import { change, userRows } from './layer.js';
import { createLinks, installLocal, labelStore, trustHostKey } from './link.js';
import { serveLoopback } from './loopback.js';
import { createFolders, offTheRecord } from './mounts.js';
import { createNetwork } from './network.js';
import { createNotices, reportRepairs, reportStopped } from './notices.js';
import { createPackages, globalDir, loadCatalog, writeListing } from './packages.js';
import {
  biosHash,
  mirrorNetwork,
  mirrorUpdates,
  present,
  serveNetwork,
  serveUpdates,
} from './present.js';
import { PYTHON } from './projects.js';
import { createRemote } from './remote.js';
import { installPrompts, keepStorage, onSend } from './storage.js';
import {
  claim,
  createOs,
  createTabs,
  followKernel,
  joinSwitchboard,
  localBoard,
  supported,
} from './tabs.js';
import {
  createTailscale,
  installTailscale,
  tailscaleConfig,
  tailscaleVersion,
} from './tailscale.js';
import { serveTerminal } from './terminal.js';
import { pickTransport } from './transport.js';
import { createTray, TRAY_HUB_KEY, trayPort } from './tray.js';
import { openTunnel } from './tunnel.js';
import { text, update, versions } from './update.js';
import { count, createUpdates, owners } from './updates.js';

const prompts = installPrompts();

export const layouts = {
  agents: { side: 'left', open: ['tablet', 'desktop'] },
  browser: { side: 'right', open: [] },
  changes: { side: 'left', open: [] },
  chat: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  terminal: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  files: { side: 'left', open: ['tablet', 'desktop'] },
  freezer: { side: 'left', open: [] },
  memory: { side: 'left', open: [] },
  monitor: { side: 'right', open: [] },
  network: { side: 'right', open: [] },
  settings: { side: 'center', open: [] },
  updates: { side: 'center', open: [] },
};

const STUCK = "Couldn't start the agent. Retry, or reload the page.";

export const hide = ['/.slicc', '/.slicc-unlinked'];

export const skip = [
  '/node_modules',
  '/opt/agent/node_modules',
  '/opt/grammars/node_modules',
  '/opt/slicc',
  '/home/.local/share/pnpm',
  '/usr/local/share/pnpm',
  '/home/.cache',
  '/root/.cache',
];

export function offered(all) {
  return Object.entries(layouts).map(([id, layout]) => ({
    ...all.find((item) => item.id === id),
    ...layout,
  }));
}

const network = await pickTransport();
const { kind } = network;
const browser = createBrowser(network);
const control = browserControl(network, { observe: browser.observe, links: () => links });
const exits = createExitRouter();
const tailscale = createTailscale(await tailscaleConfig(), { router: exits });
const remote = createRemote({
  control: () => remoteAgent(owner, { cone: () => app.model?.agent?.active?.() }),
  onChange: () => links.changed(),
});
function linkFolders(link) {
  const list = links
    .mounts()
    .filter((entry) => entry.link === link)
    .map(({ source, mount }) => {
      const mounted = folders?.mountedAt(source);
      return {
        name: mount.name,
        source,
        readonly: mount.readonly,
        ...(mounted ? { mounted } : {}),
      };
    });
  return list.length ? { folders: list } : {};
}
const allowedRemotely = (link) => link.mode === 'local' || Boolean(tray?.controlAllowed(link.id));
let followers = null;
const links = createLinks({
  router: exits,
  labels: labelStore(localStorage),
  agent: { allowed: allowedRemotely, handle: (link, meta, s) => remote.handle(link, meta, s) },
  sevens: {
    hello: (link) => followers.hello(link),
    accept: (link, meta) => followers.accept(link, meta),
  },
  describe: (link) =>
    link.kind === 'seven'
      ? followers.describe(link)
      : {
          kind: 'cli',
          access:
            link.mode === 'local'
              ? { control: true, fixed: true }
              : { control: allowedRemotely(link) },
          control:
            link.mode === 'local'
              ? { allowed: true, fixed: true }
              : { allowed: allowedRemotely(link) },
          ...(remote.controlling(link) ? { controlling: remote.controlling(link) } : {}),
          ...linkFolders(link),
        },
  name: `seven on ${location.host}`,
  makePeer: (config) => new RTCPeerConnection(config),
  kernel: () => kernel,
  serveFs: serveHostfsPort,
  onLink: (link, peer) => {
    trustHostKey(kernel, link, peer).catch((error) => console.warn(`link: ${error.message}`));
  },
});
const hub = location.hostname.endsWith('.sliccy.ai')
  ? location.origin
  : localStorage.getItem(TRAY_HUB_KEY);
const tray = hub
  ? createTray({
      links,
      origin: hub,
      page: location.origin,
      onWebhook: (name, delivery) => deliverWebhook(owner, name, delivery),
    })
  : null;
followers = tray
  ? createFollowers({
      tray,
      name: deviceName(),
      serve: {
        pi: (_link, _meta, stream, access) =>
          bridgeAgent(owner, stream, { readOnly: !access.control }),
        terminal: (_link, meta, stream) => serveTerminal(kernel, meta, stream),
      },
      onChange: () => links.changed(),
    })
  : null;
const reach = createNetwork(network, {
  browser: control.status,
  tailnet: tailscale.panel,
  router: exits,
  links,
  tray,
  linkedFolders: {
    mount: (source) => folders.mountLinked(source),
    eject: (source) => folders.ejectLinked(source),
  },
});
const transport = exits.transport(reach.transport);
const login = signIn({ network });
document.documentElement.dataset.transport = kind;
const root = await navigator.storage.getDirectory();
const app = document.querySelector('slicc-app');
app.layoutKey = 'slicc-os.layout';
app.surfaces = offered(surfaces);
const read = async (name) => (await text(root, `os/${name}`)) ?? '';
let mine = { bios: await biosHash(read), agent: await agentVersion(), run: 0 };
const tabs = createTabs();
const shared = supported();
const visible = () => document.visibilityState === 'visible';
const board = shared
  ? await joinSwitchboard({ visible: visible(), versions: mine })
  : localBoard({ versions: mine });
document.addEventListener('visibilitychange', () => board.show(visible()));
const claimed = await claim();
const updates = createUpdates();
const notices = createNotices();
reportRepairs(notices);
reportStopped(notices);
const keep = keepStorage({ notices, prompts });
let model = null;
let files = null;
let presentation = null;
let kernel = null;
let folders = null;
let owner = null;
let agent = null;
let startedWith = null;
let owned = new Map();
let serving = null;
let optional = Promise.resolve(null);

const start = () => createKernel({ root, network: { transport }, media: false });

function base(os) {
  const network = os ? mirrorNetwork(os, reach.port) : reach.port;
  return {
    ...files,
    agent: browser.stopping(files.agent),
    updates: os ? mirrorUpdates(os) : updates,
    notices,
    network,
    browser: browser.port,
    tray: trayPort(network, { name: `seven on ${location.host}` }),
  };
}

async function give(_from, names) {
  return {
    kernel: names.includes('kernel') ? await kernel.connect() : null,
    agent: names.includes('agent') && owner ? await owner.port() : null,
    os: names.includes('os') ? serving.open() : null,
  };
}

function announce(agentAt) {
  mine = { ...mine, agent: agentAt, run: mine.run + 1 };
  const attached = presentation.next();
  board.own(give, mine);
  return attached;
}

async function installTailnet(report = () => {}) {
  const track = updates.track('tailscale');
  try {
    const changed = await installTailscale(start, {
      report: (step) => {
        report(step);
        track(step);
      },
    });
    const at = await tailscaleVersion();
    updates.checked(
      'tailscale',
      changed ? { state: 'installed', from: at, to: at } : { from: at, to: at }
    );
    return changed;
  } catch (error) {
    updates.fail('tailscale', error);
    throw error;
  }
}

async function started(chat, lock) {
  if (chat) {
    startedWith = lock;
    updates.setReady(true);
    return chat;
  }
  agent = null;
  if ((await agentVersion()) === null) updates.setReady(true);
  else updates.fail('agent', Object.assign(new Error('the agent did not start'), { plain: STUCK }));
  return chat;
}

async function launch() {
  try {
    owner = await startChat(kernel);
    if (await announce(await agentVersion())) return owner;
  } catch (error) {
    console.warn(`the agent did not start: ${error.message}`);
  }
  await owner?.release();
  owner = null;
  return null;
}

function startOnce() {
  if (!agent) {
    const lock = recorded();
    const back = updates.get('agent').state === 'installed' ? 'installed' : 'current';
    if (!updates.ready()) updates.set('agent', { state: 'starting' });
    agent = launch().then(async (chat) => {
      if (updates.get('agent').state === 'starting') updates.set('agent', { state: back });
      return started(chat, await lock);
    });
  }
  return agent;
}

async function relaunch(running) {
  try {
    owner = await restartChat(kernel, running);
    if (await announce(await agentVersion())) return owner;
  } catch (error) {
    console.warn(`the agent did not restart: ${error.message}`);
  }
  await owner?.release();
  owner = null;
  return null;
}

async function restart() {
  const running = await agent;
  await whenIdle(app.model.agent);
  const lock = recorded();
  agent = relaunch(running).then(async (restarted) => started(restarted, await lock));
  if (!(await agent)) {
    updates.fail(
      'agent',
      Object.assign(new Error('the agent did not restart'), {
        plain: "Couldn't restart the agent. Retry, or reload the page.",
      })
    );
    return;
  }
  const at = await agentVersion();
  updates.checked('agent', { state: 'current', from: at, to: at, actions: [] });
}

const layered = { agent: agentProject, grammars: grammarsProject };
const UNDOING = { unpin: 'removing', remove: 'removing', retry: 'updating' };

async function listOwn() {
  const list = [];
  for (const project of Object.values(layered)) list.push(...(await userRows(root, project)));
  updates.setUserPackages(list);
}

function refuse(list, project) {
  for (const { name, kind, spec, keeps } of list) {
    const what = kind === 'pin' ? 'pin of' : 'addition of';
    const short = name.replace(/^@ai-ecoverse\/(?:slicc-)?/, '');
    notices.show(
      {
        id: `refused:${project.id}:${name}@${spec}`,
        tone: 'warning',
        title: `Seven undid a change in /${project.folder}`,
        body: `Seven undid your ${what} ${name} in /${project.folder}: it has to match seven's ${short} ${keeps}.`,
        actions: [],
      },
      () => {}
    );
  }
}

async function actOwn(id, action) {
  const which = id.split(':')[1];
  const name = id.slice(`user:${which}:`.length);
  updates.setUserPackages(
    updates
      .userPackages()
      .map((row) =>
        row.id === id ? { ...row, state: UNDOING[action], error: null, actions: [] } : row
      )
  );
  await change(layered[which], action === 'retry' ? null : name);
  await (which === 'agent' ? offerChat() : installGrammars());
}

async function offerChat() {
  try {
    const changed = await installAgent(start, { report: updates.track('agent'), refuse });
    await listOwn();
    const at = await agentVersion();
    const running = agent && (await agent);
    if (running && (await recorded()) !== startedWith) {
      updates.checked('agent', {
        state: 'ready',
        progress: null,
        to: at,
        actions: ['restart-agent'],
      });
      return;
    }
    updates.checked('agent', changed ? { state: 'installed', from: at, to: at } : {});
    await startOnce();
  } catch (error) {
    updates.fail('agent', error);
    await listOwn();
  }
}

async function checkPackages() {
  try {
    const changes = await update(kernel, { report: updates.track('bios') });
    for (const id of owned.values()) updates.checked(id);
    if (!changes) {
      updates.checked('bios');
      return;
    }
    const rest = changes.filter(({ name }) => !owned.has(name));
    for (const { name, from, to } of changes.filter(({ name }) => owned.has(name))) {
      updates.set(owned.get(name), { state: 'ready', from, to, actions: ['reload'] });
    }
    updates.checked(
      'bios',
      rest.length
        ? {
            state: 'ready',
            progress: null,
            actions: ['reload'],
            log: rest.map(({ name, from, to }) => `${name} ${from ?? 'new'} → ${to}`).join('\n'),
          }
        : { state: 'current', progress: null }
    );
  } catch (error) {
    updates.fail('bios', error);
  }
}

async function installGrammars() {
  try {
    const changed = await grammars(start, { report: updates.track('grammars'), refuse });
    const at = await grammarsVersion();
    updates.checked('grammars', changed ? { state: 'installed', from: at, to: at } : {});
    app.grammarBase = grammarBase;
  } catch (error) {
    updates.fail('grammars', error);
  }
  await listOwn();
}

async function updateTailnet() {
  if (tailscale.panel.status().state !== 'running') return;
  const changed = await installTailnet().catch(() => false);
  if (changed) updates.set('tailscale', { state: 'ready', actions: ['reload'] });
}

async function check() {
  await checkPackages();
  await offerChat();
  await installGrammars();
  await updateTailnet();
  await (await optional)?.refresh().catch(() => undefined);
}

function offerPackages() {
  return loadCatalog()
    .then(async (catalog) => {
      await writeListing(root, catalog.entries);
      const packages = createPackages({
        catalog,
        root,
        kernel,
        global: await globalDir(kernel),
        ask: confirm,
        emit: updates.setPackages,
      });
      updates.handlePackages(packages.act);
      await packages.refresh();
      void packages.move().catch((error) => console.warn(`optional packages: ${error.message}`));
      return packages;
    })
    .catch((error) => {
      console.warn(`optional packages are unavailable: ${error.message}`);
      return null;
    });
}

const retry = {
  agent: offerChat,
  grammars: installGrammars,
  tailscale: () => tailscale.panel.check(),
  bios: checkPackages,
  kernel: checkPackages,
  ui: checkPackages,
};
updates.handleUserPackages(actOwn);
updates.handle('retry', (id) => retry[id]());
updates.handle('update-now', (id) => retry[id]());
updates.handle('restart-agent', restart);
updates.handle('reload', () => location.replace(new URL('../', location.href)));

async function rows() {
  owned = new Map(Object.entries(owners).map(([id, name]) => [name, id]));
  const manifest = JSON.parse((await text(root, 'package.json')) ?? '{}');
  const names = Object.keys(manifest.dependencies ?? {});
  const found = await versions(root, names);
  for (const [id, name] of Object.entries(owners)) {
    updates.set(id, { from: found[name], to: found[name] });
  }
  const others = count(names.filter((name) => !owned.has(name)).length);
  updates.set('bios', { from: others, to: others });
  const waiting = (at) => ({ from: at, to: at, state: at ? 'current' : 'queued' });
  updates.set('agent', waiting(await agentVersion()));
  updates.set('grammars', waiting(await grammarsVersion()));
  const tailscaleAt = await tailscaleVersion();
  updates.set('tailscale', { from: tailscaleAt, to: tailscaleAt });
  await listOwn();
}

async function own() {
  folders = createFolders({
    storage: localStorage,
    network,
    secret: await offTheRecord(),
    linked: links,
  });
  kernel = await createKernel({
    root,
    env: { PYTHONPATH: `/${PYTHON}` },
    network: { transport, uplink: exits.uplink },
    cdp: control.hook,
    ...folders.options,
  });
  exits.attach(kernel);
  installLocal(links);
  tray?.start();
  if (network.status?.probe?.kernelTunnel) openTunnel(kernel, network.proxy);
  files = await folders.attach(kernel, model);
  files.files.on('mounts', links.changed);
  const served = serveUpdates(updates);
  const routes = serveNetwork(reach.port);
  serving = createOs({ ...served.handlers, ...routes.handlers });
  served.forward(serving);
  routes.forward(serving);
  await rows();
  await announce(null);
  const restoring = folders.restore();
  void tailscale.start({
    kernel,
    ready: restoring,
    traits: reach.transport.traits,
    install: installTailnet,
  });
  if (await agentInstalled()) void startOnce();
  if (await installed()) app.grammarBase = grammarBase;
  optional = offerPackages();
  document.addEventListener('visibilitychange', () => {
    if (visible()) void check();
  });
  setInterval(check, 15 * 60 * 1000);
  await check();
}

async function follow() {
  const facade = followKernel({
    port: async () => (await board.ports(['kernel'])).kernel,
    attach: attachKernel,
  });
  serveLoopback(facade);
  model = createKernelModel({
    kernel: facade,
    root,
    storage: localStorage,
    files: { skip, hide },
    terminals: { env: { PS1: 'slicc:\\w\\$ ', SLICC_TAB: board.id } },
  });
  files = model;
  const waiting = claimed.owner ? updates : createUpdates({ ready: true });
  app.model = {
    ...model,
    updates: waiting,
    notices,
    network: reach.port,
    browser: browser.port,
    tabs,
  };
  await app.updateComplete;
  presentation = present({
    app,
    board,
    tabs,
    base,
    versions: mine,
    chat: () => loadChat(),
    wrap: (agent) => onSend(browser.stopping(agent), keep.sent),
    storage: localStorage,
    login,
    disk: () => biosHash(read),
  });
  void presentation.attach();
}

async function alone() {
  await follow();
  await own();
}

if (!shared && !claimed.owner) {
  void claimed.next.then(alone);
  tabs.set({ role: 'alone' });
  app.model = {
    ...createKernelModel({
      kernel: { openTerminal: () => new Promise(() => {}) },
      root,
      storage: localStorage,
      terminals: { open: 0 },
    }),
    tabs,
  };
} else {
  await follow();
  if (claimed.owner) await own();
  else void claimed.next.then(own);
}
