import { readFile } from 'node:fs/promises';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { compare, within } from '../../src/seed/packages.js';

const REGISTRY = 'https://registry.npmjs.org/';
const CATALOG = new URL('../../src/packages/optional/catalog.json', import.meta.url);

export async function catalog() {
  return JSON.parse(await readFile(CATALOG, 'utf8'));
}

const PINS = new URL('../../src/packages/optional/package.json', import.meta.url);

export async function offered(name) {
  const pin = JSON.parse(await readFile(PINS, 'utf8')).dependencies?.[name];
  if (pin) return pin;
  const entry = (await catalog())[name];
  if (!entry?.range) return JSON.parse(await download(`${REGISTRY}${name}/latest`)).version;
  const { versions } = JSON.parse(await download(`${REGISTRY}${name}`));
  return Object.keys(versions)
    .filter((version) => within(version, entry.range) && !versions[version].deprecated)
    .sort(compare)
    .at(-1);
}
