import { createKernel } from '@ai-ecoverse/slicc-kernel';
import { createKernelModel } from '@ai-ecoverse/slicc-spectrum/kernel';
import { surfaces } from '@ai-ecoverse/slicc-spectrum/ui';
import { signIn } from './adobe.js';
import {
  installed as agentInstalled,
  installAgent,
  recorded,
  restartChat,
  startChat,
  whenIdle,
} from './agent.js';
import { grammarBase, grammars, installed } from './grammars.js';
import { createFolders, offTheRecord } from './mounts.js';
import { showNetwork } from './network.js';
import { pickTransport } from './transport.js';
import { update } from './update.js';

export const layouts = {
  agents: { side: 'left', open: ['tablet', 'desktop'] },
  chat: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  terminal: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  files: { side: 'left', open: ['tablet', 'desktop'] },
  settings: { side: 'center', open: [] },
};

export const hide = ['/.slicc'];

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
const { kind, transport } = network;
const signInNotice = document.querySelector('.sign-in');
const [signInStatus, signInCancel] = signInNotice.children;
let cancelSignIn = () => {};
signInCancel.addEventListener('click', () => cancelSignIn());

export function showSignIn({ text, cancel }) {
  cancelSignIn = cancel;
  signInNotice.title = text;
  signInStatus.value = text;
  signInNotice.hidden = false;
  return () => {
    signInNotice.hidden = true;
    cancelSignIn = () => {};
  };
}

const login = signIn({ network, notice: showSignIn });
document.documentElement.dataset.transport = kind;
showNetwork(document.querySelector('.network'), network);
const root = await navigator.storage.getDirectory();
const app = document.querySelector('slicc-app');
const folders = createFolders({
  app,
  storage: localStorage,
  network,
  secret: await offTheRecord(),
});
const kernel = await createKernel({ root, network: { transport }, ...folders.options });
app.layoutKey = 'slicc-os.layout';
app.surfaces = offered(surfaces);
const base = await folders.attach(
  kernel,
  createKernelModel({
    kernel,
    root,
    storage: localStorage,
    files: { skip, hide },
    terminals: { env: { PS1: 'slicc:\\w\\$ ' } },
  })
);
app.model = base;
await app.updateComplete;
app.show('terminal');
void folders.restore();
let agent = null;
let startedWith = null;
function started(chat, lock) {
  if (chat) startedWith = lock;
  else agent = null;
  return chat;
}
function startOnce() {
  if (!agent) {
    const lock = recorded();
    agent = offerAgent(app, base, startChat(kernel), login).then(async (chat) =>
      started(chat, await lock)
    );
  }
  return agent;
}
if (await agentInstalled()) void startOnce();
if (await installed()) app.grammarBase = grammarBase;

const notice = document.querySelector('.update');
const [status, reload] = notice.children;
reload.addEventListener('click', () => location.replace(new URL('../', location.href)));

const agentNotice = document.querySelector('.agent');
const [agentStatus, agentAction] = agentNotice.children;

function showAgent(state, text, action = '') {
  agentNotice.dataset.state = state;
  agentNotice.title = text;
  agentStatus.value = text;
  agentAction.textContent = action;
  agentNotice.hidden = false;
}

async function restart() {
  showAgent('active', 'restarting the agent once it is idle…');
  const chat = await agent;
  await whenIdle(app.model.agent);
  const lock = recorded();
  agent = offerAgent(app, base, restartChat(chat), login).then(async (restarted) =>
    started(restarted, await lock)
  );
  if (await agent) agentNotice.hidden = true;
  else showAgent('failed', 'the agent did not restart', 'Retry');
}

async function offerChat() {
  try {
    await installAgent(() => createKernel({ root, network: { transport }, media: false }), {
      report: (text) => showAgent('active', text),
    });
    const running = agent && (await agent);
    if (running && (await recorded()) !== startedWith) {
      showAgent('ready', 'agent updated', 'Restart agent');
      return;
    }
    agentNotice.hidden = true;
    await startOnce();
  } catch (error) {
    showAgent('failed', `agent install failed: ${error.message}`, 'Retry');
  }
}

agentAction.addEventListener(
  'click',
  () => void (agentNotice.dataset.state === 'ready' ? restart() : offerChat())
);

function show(state, text) {
  notice.dataset.state = state;
  notice.title = text;
  status.value = text;
  notice.hidden = false;
}

async function check() {
  try {
    const changes = await update(kernel, { report: (text) => show('active', text) });
    if (changes) show('ready', `updated ${changes.join(', ') || 'packages'}`);
  } catch (error) {
    show('failed', `update failed: ${error.message}`);
  }
  await offerChat();
  try {
    await grammars(() => createKernel({ root, network: { transport }, media: false }));
    app.grammarBase = grammarBase;
  } catch (error) {
    console.warn(`grammars stay on jsDelivr: ${error.message}`);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void check();
});
setInterval(check, 15 * 60 * 1000);
await check();
