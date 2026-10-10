import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const optional = new URL('../../src/packages/optional/', import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, optional), 'utf8'));

test('the optional catalog describes exactly the pinned packages, each locked with its integrity', async () => {
  const catalog = await read('catalog.json');
  const { dependencies } = await read('package.json');
  const lock = await read('package-lock.json');
  assert.deepEqual(Object.keys(catalog).sort(), Object.keys(dependencies).sort());
  for (const [name, version] of Object.entries(dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(-[\w.]+)?$/, `${name} is pinned exactly`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry?.version, version, `${name} is locked at ${version}`);
    assert.match(entry.integrity, /^sha512-/, `${name} has an integrity`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path) assert.match(entry.integrity ?? '', /^sha512-/, `${path} has an integrity`);
  }
  const text = await readFile(new URL('package-lock.json', optional), 'utf8');
  const keys = [...text.matchAll(/^ {4}"(node_modules\/[^"]+)": \{$/gm)].map(([, key]) => key);
  assert.deepEqual(keys, [...new Set(keys)], 'each locked path appears once');
  for (const path of keys.filter((key) => key.includes('/node_modules/', 1))) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    assert.notEqual(
      lock.packages[path].version,
      lock.packages[`node_modules/${name}`]?.version,
      `${path} duplicates the top-level ${name}`
    );
  }
});

test('every catalog entry has a unique id, a label, a description, commands and a size, and requires only other entries without cycles', async () => {
  const entries = Object.values(await read('catalog.json'));
  const ids = entries.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of entries) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(entry.label && entry.description && entry.commands.length, entry.id);
    assert.ok(Number.isInteger(entry.size) && entry.size > 0, entry.id);
    for (const id of entry.requires ?? [])
      assert.ok(ids.includes(id), `${entry.id} requires ${id}`);
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const visit = (id, path) => {
    assert.ok(!path.includes(id), `requires cycle: ${[...path, id].join(' → ')}`);
    for (const next of byId.get(id).requires ?? []) visit(next, [...path, id]);
  };
  for (const id of ids) visit(id, []);
});
