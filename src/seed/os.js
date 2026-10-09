import { createKernel } from '@ai-ecoverse/slicc-kernel';
import { createKernelModel } from '@ai-ecoverse/slicc-spectrum/kernel';
import { confirm, surfaces } from '@ai-ecoverse/slicc-spectrum/ui';
import { signIn } from './adobe.js';
import {
  installed as agentInstalled,
  version as agentVersion,
  installAgent,
  recorded,
  restartChat,
  startChat,
  whenIdle,
} from './agent.js';
import { ASK, browserControl } from './cdp.js';
import { grammarBase, grammars, version as grammarsVersion, installed } from './grammars.js';
import { serveLoopback } from './loopback.js';
import { createFolders, offTheRecord } from './mounts.js';
import { createNetwork } from './network.js';
import { prepareTailscale, tailscaleConfig } from './tailscale.js';
import { pickTransport } from './transport.js';
import { openTunnel } from './tunnel.js';
import { text, update, versions } from './update.js';
import { count, createUpdates, owners } from './updates.js';

export const layouts = {
  agents: { side: 'left', open: ['tablet', 'desktop'] },
  changes: { side: 'left', open: [] },
  chat: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  terminal: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  files: { side: 'left', open: ['tablet', 'desktop'] },
  freezer: { side: 'left', open: [] },
  memory: { side: 'left', open: [] },
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
  '/home/.local/share/pnpm',
  '/home/.cache',
];

export function offerAgent(app, base, connecting, login) {
  return connecting.then(
    (chat) => {
      app.model = {
        ...base,
        ...chat.createAgentModel(chat.connection, { storage: localStorage, login }),
      };
      return chat;
    },
    (error) => {
      console.warn(`the agent did not start: ${error.message}`);
      return null;
    }
  );
}

export function offered(all) {
  return Object.entries(layouts).map(([id, layout]) => ({
    ...all.find((item) => item.id === id),
    ...layout,
  }));
}

const network = await pickTransport();
const { kind } = network;
const control = browserControl(
  network,
  () => confirm(ASK),
  () => reach.changed()
);
const reach = createNetwork(network, { browser: control.status });
const tailscale = prepareTailscale({ transport: reach.transport }, await tailscaleConfig());
const transport = tailscale?.transport ?? reach.transport;
const login = signIn({ network });
document.documentElement.dataset.transport = kind;
const root = await navigator.storage.getDirectory();
const app = document.querySelector('slicc-app');
const folders = createFolders({
  storage: localStorage,
  network,
  secret: await offTheRecord(),
});
const kernel = await createKernel({
  root,
  network: { transport },
  cdp: control.hook,
  ...folders.options,
});
serveLoopback(kernel);
if (network.status?.probe?.kernelTunnel) openTunnel(kernel, network.proxy);
app.layoutKey = 'slicc-os.layout';
app.surfaces = offered(surfaces);
const updates = createUpdates();
const base = {
  ...(await folders.attach(
    kernel,
    createKernelModel({
      kernel,
      root,
      storage: localStorage,
      files: { skip, hide },
      terminals: { env: { PS1: 'slicc:\\w\\$ ' } },
    })
  )),
  updates,
  network: reach.port,
};
const owned = new Map(Object.entries(owners).map(([id, name]) => [name, id]));
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
app.model = base;
await app.updateComplete;
const restoring = folders.restore();
void tailscale?.start({ kernel, ready: restoring, notice: document.querySelector('.tailscale') });
let agent = null;
let startedWith = null;
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
function startOnce() {
  if (!agent) {
    const lock = recorded();
    const back = updates.get('agent').state === 'installed' ? 'installed' : 'current';
    if (!updates.ready()) updates.set('agent', { state: 'starting' });
    agent = offerAgent(app, base, startChat(kernel), login).then(async (chat) => {
      if (updates.get('agent').state === 'starting') updates.set('agent', { state: back });
      return started(chat, await lock);
    });
  }
  return agent;
}
if (await agentInstalled()) void startOnce();
if (await installed()) app.grammarBase = grammarBase;

const start = () => createKernel({ root, network: { transport }, media: false });

async function restart() {
  const chat = await agent;
  await whenIdle(app.model.agent);
  const lock = recorded();
  agent = offerAgent(app, base, restartChat(chat), login).then(async (restarted) =>
    started(restarted, await lock)
  );
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

async function offerChat() {
  try {
    const changed = await installAgent(start, { report: updates.track('agent') });
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
    const changed = await grammars(start, { report: updates.track('grammars') });
    const at = await grammarsVersion();
    updates.checked('grammars', changed ? { state: 'installed', from: at, to: at } : {});
    app.grammarBase = grammarBase;
  } catch (error) {
    updates.fail('grammars', error);
  }
}

const retry = {
  agent: offerChat,
  grammars: installGrammars,
  bios: checkPackages,
  kernel: checkPackages,
  ui: checkPackages,
};
updates.handle('retry', (id) => retry[id]());
updates.handle('update-now', (id) => retry[id]());
updates.handle('restart-agent', restart);
updates.handle('reload', () => location.replace(new URL('../', location.href)));

async function check() {
  await checkPackages();
  await offerChat();
  await installGrammars();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void check();
});
setInterval(check, 15 * 60 * 1000);
await check();
