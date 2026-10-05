import { join } from 'node:path';
import { root } from './server.mjs';

export const artifacts = new URL('../../artifacts/', import.meta.url);
export const raw = new URL('../../node_modules/.cache/slicc-bios-coverage/', import.meta.url);

export function source(url) {
  return join(root, new URL(url).pathname.slice(1).replace(/^os\//, 'seed/'));
}

export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
