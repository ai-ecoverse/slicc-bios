import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { scanImports } from '../../src/sw/scan.js';

const src = new URL('../../src/', import.meta.url);
const seed = new URL('seed/', src);

async function installed() {
  const bios = await readFile(new URL('bios.js', src), 'utf8');
  const [, list] = bios.match(/step\('seed'[\s\S]*?const files = \[([\s\S]*?)\];/);
  return [...list.matchAll(/'([^']+)'/g)].map(([, name]) => name);
}

function local(specifier, from) {
  if (specifier.startsWith('/os/')) return specifier.slice('/os/'.length);
  if (!specifier.startsWith('.')) return null;
  return new URL(specifier, new URL(from, 'https://seed.test/os/')).pathname.slice('/os/'.length);
}

test('the BIOS installs every file in src/seed, and nothing else', async () => {
  assert.deepEqual((await installed()).sort(), (await readdir(seed)).sort());
});

test('every page, script and import the seed reaches is installed with it', async () => {
  const files = new Set(await installed());
  const pages = (await readdir(seed)).filter((name) => name.endsWith('.html'));
  const queue = [];
  for (const page of pages) {
    const html = await readFile(new URL(page, seed), 'utf8');
    for (const [, target] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const name = local(target.startsWith('/') ? target : `./${target}`, page);
      if (name) queue.push([name, page]);
    }
  }
  const seen = new Set();
  while (queue.length) {
    const [name, from] = queue.shift();
    assert.ok(files.has(name), `${from} reaches os/${name}, which src/bios.js does not install`);
    if (seen.has(name) || !name.endsWith('.js')) continue;
    seen.add(name);
    for (const { value } of scanImports(await readFile(new URL(name, seed), 'utf8'))) {
      const target = local(value, name);
      if (target) queue.push([target, name]);
    }
  }
  assert.ok(seen.has('os.js'));
  assert.ok(seen.has('loopback.js'));
});
