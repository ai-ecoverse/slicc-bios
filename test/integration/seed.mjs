import { readFile } from 'node:fs/promises';

export async function seedFiles() {
  const bios = await readFile(new URL('../../src/bios.js', import.meta.url), 'utf8');
  const [, list] = bios.match(/step\('seed'[\s\S]*?const files = \[([\s\S]*?)\];/);
  return [...list.matchAll(/'([^']+)'/g)].map(([, name]) => name);
}
