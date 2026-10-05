import { createKernel } from '@ai-ecoverse/slicc-kernel';
import { kernelBackend } from '@ai-ecoverse/slicc-spectrum';
import { pickTransport } from './transport.js';

const { kind, transport } = await pickTransport();
document.documentElement.dataset.transport = kind;
const kernel = await createKernel({
  root: await navigator.storage.getDirectory(),
  network: { transport },
});
const terminal = document.querySelector('slicc-terminal');
terminal.backend = kernelBackend(kernel, { cwd: '/home', env: { PS1: 'slicc:\\w\\$ ' } });
await terminal.ready;
terminal.focus();
