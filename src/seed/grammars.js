import { fetchText, pnpm, text, versions, write } from './update.js';

const deployed = new URL('../packages/grammars/', import.meta.url);
export const folder = 'opt/grammars';
export const grammarBase = new URL(`../${folder}/node_modules/@shikijs/`, import.meta.url).href;
const receipt = 'var/lib/slicc/grammars/pnpm-lock.yaml';
const PACKAGE = '@shikijs/langs';

export async function installed() {
  return (await text(await navigator.storage.getDirectory(), receipt)) !== null;
}

export async function version() {
  const root = await navigator.storage.getDirectory();
  return (await versions(root, [PACKAGE], `${folder}/`))[PACKAGE];
}

async function install(start, from, report) {
  const root = await navigator.storage.getDirectory();
  const lock = await fetchText('pnpm-lock.yaml', from);
  if (lock === (await text(root, receipt))) return false;
  await write(root, `${folder}/package.json`, await fetchText('package.json', from));
  await write(root, `${folder}/pnpm-lock.yaml`, lock);
  const kernel = await start();
  try {
    await pnpm(kernel, `/${folder}`, report);
  } finally {
    kernel.terminate();
  }
  await write(root, receipt, lock);
  return true;
}

export function grammars(start, { from = deployed, report = () => {} } = {}) {
  return navigator.locks.request('slicc-grammars', () => install(start, from, report));
}
