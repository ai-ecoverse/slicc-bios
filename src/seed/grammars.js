import { apply } from './layer.js';
import { text, versions } from './update.js';

const deployed = new URL('../packages/grammars/', import.meta.url);
export const folder = 'opt/grammars';
export const grammarBase = new URL(`../${folder}/node_modules/@shikijs/`, import.meta.url).href;
const state = 'var/lib/slicc/grammars';
const receipt = `${state}/pnpm-lock.yaml`;
const PACKAGE = '@shikijs/langs';
export const project = {
  id: 'grammars',
  folder,
  state,
  from: deployed,
  primary: PACKAGE,
  lock: 'slicc-grammars',
};

export async function installed() {
  return (await text(await navigator.storage.getDirectory(), receipt)) !== null;
}

export async function version() {
  const root = await navigator.storage.getDirectory();
  return (await versions(root, [PACKAGE], `${folder}/`))[PACKAGE];
}

export function grammars(start, { from = deployed, ...options } = {}) {
  return navigator.locks.request(project.lock, async () =>
    apply(await navigator.storage.getDirectory(), { ...project, from }, { start, ...options })
  );
}
