import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const optional = new URL('../../src/packages/optional/', import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, optional), 'utf8'));

test('the optional catalog describes exactly the pinned packages, each locked with its integrity', async () => {
  const catalog = await read('catalog.json');
  const { dependencies } = await read('package.json');
  const lock = await read('package-lock.json');
  const packages = Object.entries(catalog).filter(([, entry]) => entry.kind !== 'project');
  assert.deepEqual(packages.map(([name]) => name).sort(), Object.keys(dependencies).sort());
  for (const [name, version] of Object.entries(dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(-[\w.-]+)?$/, `${name} is pinned exactly`);
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
    assert.ok(entry.label && entry.description, entry.id);
    assert.ok(
      entry.kind === 'project' || entry.commands.length || entry.requires?.length,
      `${entry.id} has commands or extends what it requires`
    );
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

test('a project entry ships its manifest, a lockfile and a workspace that overrides Python away', async () => {
  const catalog = await read('catalog.json');
  const projects = Object.entries(catalog).filter(([, entry]) => entry.kind === 'project');
  assert.ok(projects.length >= 1);
  for (const [name, entry] of projects) {
    const manifest = await read(`projects/${entry.id}/package.json`);
    assert.equal(manifest.name, name);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    for (const [dependency, version] of Object.entries(manifest.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(-[\w.-]+)?$/, `${dependency} is pinned exactly`);
    }
    const lock = await readFile(new URL(`projects/${entry.id}/pnpm-lock.yaml`, optional), 'utf8');
    for (const dependency of Object.keys(manifest.dependencies)) {
      assert.match(
        lock,
        new RegExp(
          `^ {6}'${dependency}':\\n {8}specifier: ${manifest.dependencies[dependency]}$`,
          'm'
        )
      );
    }
    const workspace = await readFile(
      new URL(`projects/${entry.id}/pnpm-workspace.yaml`, optional),
      'utf8'
    );
    assert.match(workspace, /'@ai-ecoverse\/wasix-python': '-'/);
    assert.match(lock, /^overrides:\n {2}'@ai-ecoverse\/wasix-python': '-'$/m);
    assert.ok(entry.requires.includes('python'), `${entry.id} needs the catalog's Python`);
  }
});

test('HEIF and AVIF images installs from the catalog, and heif-convert runs', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const chrome = await launch({ timeout: 120000 });
  t.after(() => chrome.close());
  const page = await chrome.page(t);
  await boot(page);
  const heif = () =>
    page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === 'heif')
    );
  await page.within(300000, async () => {
    const item = document
      .querySelector('slicc-app')
      .model.updates.packages()
      .find((entry) => entry.id === 'heif');
    return item?.state === 'available';
  });
  const result = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.actPackage('heif', 'install')
      .then(
        () => 'ok',
        (error) => error.message
      )
  );
  assert.equal(result, 'ok', (await heif())?.log);
  assert.equal((await heif()).version, '1.23.6-1');
  await run(
    page,
    'clear; heif-convert --version 2>&1 | head -1 | grep -c 1.23.6 | sed "s/^/heif ran /"'
  );
  await shows(page, 'heif ran 1');
  assert.deepEqual(page.errors, []);
});
