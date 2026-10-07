import { fetchText, text, write } from './update.js';

const deployed = new URL('../packages/grammars/', import.meta.url);
export const folder = 'opt/grammars';
export const grammarBase = new URL(`../${folder}/node_modules/@shikijs/`, import.meta.url).href;

async function install(kernel, from) {
  const root = await navigator.storage.getDirectory();
  const lock = await fetchText('pnpm-lock.yaml', from);
  if (lock === (await text(root, 'var/lib/slicc/grammars/pnpm-lock.yaml'))) return false;
  await write(root, `${folder}/package.json`, await fetchText('package.json', from));
  await write(root, `${folder}/pnpm-lock.yaml`, lock);
  const argv = ['pnpm', 'install', '--frozen-lockfile', '--trust-lockfile'];
  const { status, stderr } = await kernel.run(argv, { cwd: `/${folder}` });
  if (status) throw new Error(stderr.trim() || `pnpm exited with ${status}`);
  await write(root, 'var/lib/slicc/grammars/pnpm-lock.yaml', lock);
  return true;
}

export function grammars(kernel, { from = deployed } = {}) {
  return navigator.locks.request('slicc-grammars', () => install(kernel, from));
}
