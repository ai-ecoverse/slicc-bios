import { createKernel, fetchTransport } from '@ai-ecoverse/slicc-kernel';
import { kernelBackend } from '@ai-ecoverse/slicc-spectrum';
import { update } from './update.js';

const kernel = await createKernel({
  root: await navigator.storage.getDirectory(),
  network: { transport: fetchTransport() },
});
const terminal = document.querySelector('slicc-terminal');
terminal.backend = kernelBackend(kernel, { cwd: '/home', env: { PS1: 'slicc:\\w\\$ ' } });
await terminal.ready;
terminal.focus();

const notice = document.querySelector('.update');
const [status, reload] = notice.children;
reload.addEventListener('click', () => location.replace(new URL('../', location.href)));

function show(state, text) {
  notice.dataset.state = state;
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
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void check();
});
setInterval(check, 15 * 60 * 1000);
await check();
