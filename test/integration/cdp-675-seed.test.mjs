import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { init, parse } from 'es-module-lexer';

const seed = new URL('../../src/seed/', import.meta.url);

test('every local import under seed is included in the bios seed installation', async () => {
  await init;
  const bios = await readFile(new URL('../../src/bios.js', import.meta.url), 'utf8');
  const list = bios.match(/await step\('seed', async \(\) => \{\s*const files = \[([\s\S]*?)\];/);
  assert.ok(list, 'bios has an explicit seed installation list');
  const installed = new Set([...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
  const missing = [];
  for (const name of await readdir(seed)) {
    if (!name.endsWith('.js')) continue;
    const source = new URL(name, seed);
    const [imports] = parse(await readFile(source, 'utf8'));
    for (const entry of imports) {
      const specifier = entry.specifier;
      if (entry.type === 'static') assert.equal(typeof specifier, 'string', name);
      if (!specifier?.startsWith('.')) continue;
      const target = new URL(specifier, source);
      if (!target.href.startsWith(seed.href)) continue;
      const file = decodeURIComponent(target.pathname.slice(seed.pathname.length));
      if (!installed.has(file))
        missing.push({ importer: name, imported: specifier, missing: file });
    }
  }
  assert.deepEqual(missing, [], JSON.stringify(missing));
});
