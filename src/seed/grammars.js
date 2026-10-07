import { fetchText, text, write } from './update.js';

const deployed = new URL('../packages/grammars/', import.meta.url);
export const folder = 'opt/grammars';
export const grammarBase = new URL(`../${folder}/node_modules/@shikijs/`, import.meta.url).href;
const receipt = 'var/lib/slicc/grammars/pnpm-lock.yaml';

export async function installed() {
  return (await text(await navigator.storage.getDirectory(), receipt)) !== null;
}

async function install(start, from) {
  const root = await navigator.storage.getDirectory();
  const lock = await fetchText('pnpm-lock.yaml', from);
  if (lock === (await text(root, receipt))) return false;
  await write(root, `${folder}/package.json`, await fetchText('package.json', from));
  await write(root, `${folder}/pnpm-lock.yaml`, lock);
  const argv = ['pnpm', 'install', '--frozen-lockfile', '--trust-lockfile'];
  const kernel = await start();
  try {
    const { status, stderr } = await kernel.run(argv, { cwd: `/${folder}` });
    if (status) throw new Error(stderr.trim() || `pnpm exited with ${status}`);
  } finally {
    kernel.terminate();
  }
  await write(root, receipt, lock);
  return true;
}

export function grammars(start, { from = deployed } = {}) {
  return navigator.locks.request('slicc-grammars', () => install(start, from));
}
