import { readFile } from 'node:fs/promises';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { createNpm } from '../../src/seed/packages.js';

const PACKAGES = new URL('../../src/packages/', import.meta.url);
const KERNEL = '@ai-ecoverse/slicc-kernel';
const json = async (path) => JSON.parse(await readFile(new URL(path, PACKAGES), 'utf8'));

export function catalog() {
  return json('optional/catalog.json');
}

async function fetcher(url) {
  try {
    return new Response(await download(url));
  } catch (error) {
    if (/^404 /.test(error.message)) return new Response('not found', { status: 404 });
    throw error;
  }
}

export async function npmOf() {
  const [entries, lock, certs, sources, bundled] = await Promise.all([
    catalog(),
    json('package-lock.json'),
    json('certs.json'),
    json('optional/sources.json'),
    json('optional/exceptions.json'),
  ]);
  const shipped = new Map(
    Object.entries(lock.packages)
      .filter(([path]) => path)
      .map(([path, entry]) => [`${path.split('node_modules/').at(-1)}@${entry.version}`, entry])
      .map(([key, entry]) => [key, entry.integrity])
  );
  const base = new Map(Object.entries(certs).map(([key, { integrity }]) => [key, integrity]));
  for (const [key, integrity] of shipped) base.set(key, integrity);
  const named = { ...sources };
  for (const [name, entry] of Object.entries(entries))
    if (entry.source && entry.kind !== 'project') named[name] = entry.source;
  const have = { [KERNEL]: lock.packages[`node_modules/${KERNEL}`].version };
  return { entries, npm: createNpm({ base, shipped, sources: named, bundled, have, fetcher }) };
}

export async function offered(name) {
  const { entries, npm } = await npmOf();
  const entry = { ...entries[name], package: name };
  const found = await npm.offer(entry);
  if (found.withheld) throw new Error(`seven offers no ${name}: ${found.withheld}`);
  return found.version;
}
