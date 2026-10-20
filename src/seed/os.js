import { attachKernel, createKernel, serveHostfsPort } from '@ai-ecoverse/slicc-kernel';
import { createKernelModel } from '@ai-ecoverse/slicc-spectrum/kernel';
import { confirm, secretRules, surfaces } from '@ai-ecoverse/slicc-spectrum/ui';
import { sealedLogin, signIn } from './adobe.js';
import {
  deployed as agentDeployed,
  project as agentProject,
  startable as agentStartable,
  version as agentVersion,
  bridgeAgent,
  deliverWebhook,
  installAgent,
  loadChat,
  recorded,
  remoteAgent,
  restartChat,
  startChat,
  useVault,
  whenIdle,
} from './agent.js';
import { createApprovals, rootChecked, routeSudo, useSecretRules } from './approvals.js';
import { createBetas } from './beta.js';
import { createBrowser } from './browser.js';
import { browserControl } from './cdp.js';
import { clipboardHook } from './clipboard.js';
import { denialLog, installCommand, watchProtected } from './denials.js';
import { createExitRouter } from './exits.js';
import { LINK_PORT, LINK_URL, linkFacade, permitted, trayRequests } from './facade.js';
import { deviceName, hubClient } from './follow.js';
import { createFollowers } from './followers.js';
import {
  grammarBase,
  grammars,
  project as grammarsProject,
  version as grammarsVersion,
  installed,
} from './grammars.js';
import { clearHandOff } from './handoff.js';
import { createJerk } from './jerk.js';
import { change, userRows } from './layer.js';
import { createLeaders, proxyOf } from './leaders.js';
import { createLinks, installLocal, labelStore, trustHostKey } from './link.js';
import { serveLoopback } from './loopback.js';
import { createFolders, KEY, layoutMnt, offTheRecord } from './mounts.js';
import { createNetwork } from './network.js';
import {
  agentInstalling,
  createNotices,
  heldAgent,
  holdComposer,
  mirrorHold,
  reportRepairs,
  reportStopped,
  startingLine,
  watchWaiting,
} from './notices.js';
import { createPackages, globalDir, loadCatalog, watchShadows, writeListing } from './packages.js';
import { createPairing, takePairing } from './pair.js';
import {
  biosHash,
  mirrorNetwork,
  mirrorUpdates,
  present,
  serveNetwork,
  serveUpdates,
} from './present.js';
import { installProfile, kernelPorts } from './profile.js';
import { PYTHON } from './projects.js';
import { createNotes, createReleases } from './releases.js';
import { createRemote } from './remote.js';
import { BIOS, home, sharesOrigin } from './site.js';
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
import { followerDevice, followerTag, terminalTag } from './tags.js';
import {
  createTailscale,
  installTailscale,
  tailscaleConfig,
  tailscaleVersion,
} from './tailscale.js';
import { serveTerminal } from './terminal.js';
import { pickTransport } from './transport.js';
import { createTray, seatNotices, TRAY_HUB_KEY, trayPort } from './tray.js';
import { openTunnel } from './tunnel.js';
import {
  baseManifest,
  enforced,
  installing,
  kernelFiles,
  PROTECTED,
  protectInstalls,
  protection,
  text,
  update,
  useKernelFiles,
  versions,
  write,
} from './update.js';
import { count, createUpdates, owners } from './updates.js';
import { createUserPackages, MODULES as USER_MODULES } from './user.js';
import {
  addCone,
  dropProtectedMounts,
  homeSkips,
  kernelUsers,
  lockLegacy,
  usersMode,
} from './users.js';
import {
  createVault,
  FNOX_DIR,
  keepSudoGid,
  sealedOption,
  seedFnox,
  storedSudoGid,
  sudoGidOf,
  takesVault,
  vaultOrigin,
} from './vault.js';

const prompts = installPrompts();
let unoffered = takePairing();

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

const KERNEL = '@ai-ecoverse/slicc-kernel';
const STUCK = "Couldn't start the agent. Retry, or reload the page.";

export const hide = ['/.slicc', '/.slicc-unlinked'];

export const skip = [
  '/node_modules',
  '/opt/agent/node_modules',
  '/opt/grammars/node_modules',
  '/opt/user/node_modules',
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
clearHandOff();
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
const allowedRemotely = (link) =>
  (link.mode === 'local' && !link.paired) || Boolean(tray?.controlAllowed(link.id));
let followers = null;
const kernelPort = kernelPorts({ storage: localStorage, text, write });
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
      : link.paired
        ? { kind: 'cli', ...pairing.describe(link), ...linkFolders(link) }
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
    if (link.mode === 'local' && link.kind !== 'seven')
      kernelPort.use(root, peer).catch((error) => console.warn(`kernel port: ${error.message}`));
  },
});
const pairing = createPairing({ links });
const hub = location.hostname.endsWith('.sliccy.ai') ? home() : localStorage.getItem(TRAY_HUB_KEY);
const leaders = createLeaders({
  post: hubClient({
    origin: proxyOf(hub, home()),
    fetch: (...args) => fetch(...args),
  }),
  name: `seven on ${location.host}`,
});
const tray = hub
  ? createTray({
      links,
      origin: hub,
      page: home(),
      onWebhook: (name, delivery) => deliverWebhook(owner, name, delivery),
      onGuest: (seat, stream) => bridgeAgent(owner, stream, { guest: seat }),
    })
  : null;
followers = tray
  ? createFollowers({
      tray,
      name: deviceName(),
      serve: {
        pi: (link, _meta, stream, access) =>
          bridgeAgent(owner, stream, { readOnly: !access.control, device: link.id }),
        terminal: (link, meta, stream) => followerShell(link, meta, stream),
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
  pairing,
  leaders,
  linkedFolders: {
    mount: (source) => folders.mountLinked(source),
    eject: (source) => folders.ejectLinked(source),
  },
});
const transport = exits.transport(reach.transport);
const vault = createVault({
  origin: vaultOrigin(),
  transport,
  sudoGid: async () => storedSudoGid(localStorage),
  users: () => kernel?.users?.mode ?? 'off',
  onRequest: (req, id) => void jerk.handle(req, id),
  onCancelled: (id) => jerk.cancelled(id),
});
const jerk = createJerk({ links: () => links, vault });
useVault(vault);
const login = sealedLogin(signIn({ network, shared: sharesOrigin() }), {
  vault,
  takes: () => takesVault(mine.agent),
});
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
const notes = createNotes({ releases: createReleases() });
const updates = createUpdates({ developer: true, notes });
const notices = createNotices();
reportRepairs(notices);
reportStopped(notices);
const registration = await navigator.serviceWorker?.getRegistration();
if (registration) watchWaiting({ registration, board, notices, reload: () => location.reload() });
useSecretRules(secretRules);
const approvals = createApprovals();
const sudo = routeSudo({
  agent: () => owner,
  fallback: approvals.approve,
  offered: approvals.offered,
  where: (req) => {
    const device = followerDevice(req.tag);
    const name = device && [...links.links.values()].find((link) => link.id === device)?.peer?.name;
    return name ? `on ${name}` : undefined;
  },
});
const mode = usersMode();
protectInstalls(mode !== 'off', mode === 'enforce');
document.documentElement.dataset.users = mode;
const keep = keepStorage({ notices, prompts });
let model = null;
let files = null;
const composer = holdComposer();
let presentation = null;
let kernel = null;
let folders = null;
let owner = null;
let agent = null;
let startedWith = null;
let owned = new Map();
let serving = null;
let optional = Promise.resolve(null);
let coneIds = null;

const start = Object.assign(async () => kernel, { shared: true });
const betas = createBetas({
  root,
  kernel: start,
  updates,
  notices,
  ask: confirm,
  reinstall: offerChat,
  installed: agentVersion,
  from: agentDeployed,
});

function base(os) {
  const network = os ? mirrorNetwork(os, reach.port) : reach.port;
  return {
    ...files,
    agent: browser.stopping(heldAgent(files.agent, os ? mirrorHold(os, tabs) : composer)),
    updates: os ? mirrorUpdates(os) : updates,
    notices,
    approvals: approvals.port,
    network,
    browser: browser.port,
    vault: vault.port,
    tray: trayPort(network, { name: `seven on ${location.host}` }),
  };
}

export const SKEWED =
  'Another SLICC tab runs a different version, so this tab can’t link slicc. Reload the SLICC tabs, then open the pairing link again.';
export const UNATTACHED =
  'This tab couldn’t reach the tab running SLICC, so it can’t link slicc. Open the pairing link in that tab.';

function pairingTab(failed) {
  const { role, skew } = tabs.state();
  if (claimed.owner || role === 'owner') return 'here';
  if (skew) return SKEWED;
  return role === 'follower' ? 'here' : failed ? UNATTACHED : null;
}

async function offerPairing(failed = false) {
  const text = unoffered;
  const where = pairingTab(failed);
  if (!text || !where) return;
  unoffered = null;
  if (where !== 'here') pairing.refuse(where);
  else
    await app.model.network
      ?.pairComputer?.(text, { arrived: true })
      .catch((error) => console.warn(`pairing: ${error.message}`));
  app.show('network');
}

tabs.on('tabs', () => void offerPairing());
globalThis.addEventListener?.('hashchange', () => {
  unoffered = takePairing() ?? unoffered;
  void offerPairing();
});

async function followerShell(link, meta, stream) {
  const client = await attachKernel(await kernel.connect({ tag: followerTag(link.id) }));
  try {
    await serveTerminal(client, meta, stream);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function give(from, names) {
  return {
    kernel: names.includes('kernel') ? await kernel.connect({ tag: terminalTag(from) }) : null,
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
const yours = createUserPackages({
  root,
  kernel: () => kernel,
  projects: layered,
  strict: enforced,
  notices,
});

async function listOwn() {
  const list = [];
  for (const project of Object.values(layered)) list.push(...(await userRows(root, project)));
  list.push(...(await yours.rows()));
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
  if (which === 'user') {
    await yours.act(name, action);
    await listOwn();
    return;
  }
  await change(layered[which], action === 'retry' ? null : name);
  await (which === 'agent' ? offerChat() : installGrammars());
}

let installNotice = null;

function agentReport() {
  const track = updates.track('agent');
  const { from } = updates.get('agent');
  return (step) => {
    track(step);
    if (agent !== null || !step.to) return;
    composer.hold(startingLine(from));
    const notice = agentInstalling(from, step.to);
    installNotice = notice.id;
    notices.show(notice, () => app.show('updates'));
  };
}

async function offerChat() {
  try {
    const changed = await betas.apply((source) =>
      installAgent(start, { report: agentReport(), refuse, ...source })
    );
    await listOwn();
    const at = await agentVersion();
    if (changed)
      updates.checked('agent', {
        state: 'installed',
        from: agent === null ? at : updates.get('agent').from,
        to: at,
      });
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
    if (!changed) updates.checked('agent', {});
    await startOnce();
  } catch (error) {
    updates.fail('agent', error);
    await listOwn();
  } finally {
    composer.hold(null);
    if (installNotice) notices.remove(installNotice);
    installNotice = null;
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
  await notes.prepare(updates);
  await checkPackages();
  await yours.tidy().catch((error) => console.warn(`your packages: ${error.message}`));
  await offerChat();
  await betas.check();
  await installGrammars();
  await updateTailnet();
  const packages = await optional;
  if (packages) await notes.packages(packages.list());
  await packages?.refresh().catch(() => undefined);
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
updates.handle('reload', () => location.replace(BIOS));

async function rows() {
  owned = new Map(Object.entries(owners).map(([id, name]) => [name, id]));
  const manifest = await baseManifest(root);
  const names = Object.keys(manifest.dependencies ?? {});
  const found = await versions(root, names);
  for (const [id, name] of Object.entries(owners)) {
    updates.set(id, { from: found[name], to: found[name] });
  }
  const others = count(names.filter((name) => !owned.has(name)).length);
  updates.set('bios', { from: others, to: others });
  const waiting = (at) => ({ from: at, to: at, state: at ? 'current' : 'queued' });
  updates.set('agent', waiting(await agentVersion()));
  betas.show();
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
    owner: () => coneIds ?? { uid: 0, gid: 0 },
  });
  approvals.own();
  const denials = denialLog({ root, users: () => kernel?.users, mode });
  const link = linkFacade({
    check: async (stamp) => permitted(stamp, await sudoGidOf(kernel).catch(() => undefined)),
    leaders,
    scrub: vault.scrubText,
    trays: trayRequests({ tray, network: reach.port, hub }),
    refused: ({ pid, uid, tag }) =>
      denials({ pid, uid, tag, op: 'connect', path: LINK_URL, errno: 'EACCES' }),
  });
  kernel = await createKernel({
    root,
    users: 'off',
    env: { PYTHONPATH: `/${PYTHON}`, FNOX_CONFIG_DIR: FNOX_DIR, ...kernelPort.env() },
    ...protection(),
    network: { transport, uplink: exits.uplink },
    cdp: control.hook,
    clipboard: clipboardHook(),
    commands: { append: [USER_MODULES] },
    facades: { link: { port: LINK_PORT, hook: link } },
    ...sealedOption((await versions(root, [KERNEL]))[KERNEL], vault),
    ...folders.options,
    ...kernelUsers(mode, { approve: sudo, onDenial: denials }),
  });
  useKernelFiles(await kernelFiles(kernel, attachKernel));
  approvals.verify((req) => rootChecked((argv) => kernel.run(argv, { cwd: '/' }), req));
  const cone = await addCone(kernel);
  coneIds = cone && { uid: cone.uid, gid: cone.gid };
  denials.drain();
  await lockLegacy(kernel, { text, write, root }).catch((error) =>
    console.warn(`legacy files: ${error.message}`)
  );
  await layoutMnt(kernel).catch((error) => console.warn(`/mnt: ${error.message}`));
  await watchShadows({
    root,
    kernel,
    attach: attachKernel,
    global: await globalDir(kernel),
    report: (message) => console.warn(message),
  }).catch((error) => console.warn(`unshadow watch: ${error.message}`));
  if (mode === 'report') {
    await watchProtected({
      kernel,
      attach: attachKernel,
      paths: PROTECTED,
      log: denials,
      busy: (path) => installing(kernel, path),
    }).catch((error) => console.warn(`protect watch: ${error.message}`));
  }
  await installProfile(root, { text, write }).catch((error) =>
    console.warn(`login profile: ${error.message}`)
  );
  if (mode !== 'off') {
    await installCommand(root, kernel, write).catch((error) =>
      console.warn(`slicc-denials: ${error.message}`)
    );
  }
  exits.attach(kernel);
  if (globalThis.sliccKernelDebug === true)
    globalThis.sliccKernelClient = async () => attachKernel(await kernel.connect());
  await seedFnox(kernel, attachKernel).catch((error) =>
    console.warn(`fnox config: ${error.message}`)
  );
  const gid = await sudoGidOf(kernel).catch(() => undefined);
  keepSudoGid(localStorage, gid);
  void vault.sudoGid(gid);
  installLocal(links);
  pairing.start();
  tray?.start();
  leaders.start();
  if (network.status?.probe?.kernelTunnel) openTunnel(kernel, network.proxy);
  files = await folders.attach(kernel, model);
  files.files.on('mounts', links.changed);
  const served = serveUpdates(updates);
  const routes = serveNetwork(reach.port);
  serving = createOs({ ...served.handlers, ...routes.handlers, held: () => composer.held() });
  composer.on((line) => serving.emit('held', line));
  served.forward(serving);
  routes.forward(serving);
  await rows();
  await announce(null);
  if (enforced())
    dropProtectedMounts({ storage: localStorage, key: KEY, paths: PROTECTED, notices });
  const restoring = folders.restore();
  void tailscale.start({
    kernel,
    ready: restoring,
    traits: reach.transport.traits,
    install: installTailnet,
  });
  if (await agentStartable()) void startOnce();
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
    files: { skip: [...skip, ...homeSkips(await text(root, 'etc/passwd'))], hide },
    terminals: { env: { PS1: 'slicc:\\w\\$ ', SLICC_TAB: board.id } },
  });
  files = model;
  const waiting = claimed.owner ? updates : createUpdates({ ready: true });
  app.model = {
    ...model,
    updates: waiting,
    notices,
    approvals: approvals.port,
    network: reach.port,
    browser: browser.port,
    vault: vault.port,
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
    guests: tray ? seatNotices(tray.guests, notices) : null,
    storage: localStorage,
    login,
    disk: () => biosHash(read),
  });
  const attached = presentation.next();
  void presentation.attach();
  void offerPairing();
  void Promise.resolve(attached).then(() => offerPairing(true));
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
