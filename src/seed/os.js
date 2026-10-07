import { createKernel } from '@ai-ecoverse/slicc-kernel';
import { createKernelModel } from '@ai-ecoverse/slicc-spectrum/kernel';
import { surfaces } from '@ai-ecoverse/slicc-spectrum/ui';
import { grammarBase, grammars } from './grammars.js';
import { showNetwork } from './network.js';
import { pickTransport } from './transport.js';
import { update } from './update.js';

export const layouts = {
  terminal: { side: 'center', open: ['phone', 'tablet', 'desktop'] },
  files: { side: 'left', open: ['tablet', 'desktop'] },
};

export const skip = [
  '/node_modules',
  '/opt/grammars/node_modules',
  '/home/.local/share/pnpm',
  '/home/.cache',
];

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
app.model = createKernelModel({
  kernel,
  root,
  storage: localStorage,
  files: { skip },
  terminals: { env: { PS1: 'slicc:\\w\\$ ' } },
});
await app.updateComplete;
app.show('terminal');

const notice = document.querySelector('.update');
const [status, reload] = notice.children;
reload.addEventListener('click', () => location.replace(new URL('../', location.href)));

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
  try {
    await grammars(kernel);
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
