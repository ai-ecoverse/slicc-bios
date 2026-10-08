import { createKernel } from '@ai-ecoverse/slicc-kernel';
import { createKernelModel } from '@ai-ecoverse/slicc-spectrum/kernel';
import { surfaces } from '@ai-ecoverse/slicc-spectrum/ui';
import {
  installed as agentInstalled,
  installAgent,
  restartChat,
  startChat,
  whenIdle,
} from './agent.js';
import { grammarBase, grammars, installed } from './grammars.js';
import { showNetwork } from './network.js';
import { pickTransport } from './transport.js';
import { update } from './update.js';

export const layouts = {
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

export function offerAgent(app, base, connecting) {
  return connecting.then(
    (chat) => {
      app.model = { ...base, ...chat.createAgentModel(chat.connection, { storage: localStorage }) };
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
document.documentElement.dataset.transport = kind;
showNetwork(document.querySelector('.network'), network);
const root = await navigator.storage.getDirectory();
const kernel = await createKernel({ root, network: { transport } });
const app = document.querySelector('slicc-app');
app.layoutKey = 'slicc-os.layout';
app.surfaces = offered(surfaces);
const base = createKernelModel({
  kernel,
  root,
  storage: localStorage,
  files: { skip, hide },
  terminals: { env: { PS1: 'slicc:\\w\\$ ' } },
});
app.model = base;
await app.updateComplete;
app.show('terminal');
let agent = null;
function startOnce() {
  agent ??= offerAgent(app, base, startChat(kernel)).then((chat) => {
    if (!chat) agent = null;
    return chat;
  });
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
  agent = offerAgent(app, base, restartChat(chat)).then((restarted) => {
    if (!restarted) agent = null;
    return restarted;
  });
  if (await agent) agentNotice.hidden = true;
  else showAgent('failed', 'the agent did not restart', 'Retry');
}

async function offerChat() {
  const running = agent;
  try {
    const changed = await installAgent(() => createKernel({ root, network: { transport } }), {
      report: (text) => showAgent('active', text),
    });
    agentNotice.hidden = true;
    if (changed && (await running)) showAgent('ready', 'agent updated', 'Restart agent');
    else await startOnce();
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
    await grammars(() => createKernel({ root, network: { transport } }));
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
