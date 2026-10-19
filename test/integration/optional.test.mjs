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

test('no two catalog entries provide the same command, so installing one never silently shadows another', async () => {
  const owners = new Map();
  for (const [name, entry] of Object.entries(await read('catalog.json')))
    for (const command of entry.commands ?? []) {
      assert.equal(
        owners.get(command),
        undefined,
        `${command}: ${owners.get(command)} and ${name}`
      );
      owners.set(command, name);
    }
  assert.equal(owners.get('magick'), '@ai-ecoverse/wasm-imagemagick-heif');
});

test('a project entry ships its manifest, a lockfile and a workspace that overrides Python away', async () => {
  const catalog = await read('catalog.json');
  const projects = Object.entries(catalog).filter(([, entry]) => entry.kind === 'project');
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
  assert.equal((await heif()).version, '1.23.6-6');
  await run(
    page,
    'clear; heif-convert --version 2>&1 | head -1 | grep -c 1.23.6 | sed "s/^/heif ran /"'
  );
  await shows(page, 'heif ran 1');
  assert.deepEqual(page.errors, []);
});

test('Python data tools are back as homescoop’s attested CI builds: one project of numpy, pandas and matplotlib that locks a single numpy, at least 2.3.2-12 (homescoop#1082), and no Python of its own, with scipy neither locked nor certified and no decertified numpy or pandas certified', async () => {
  const catalog = await read('catalog.json');
  const entry = catalog['slicc-py-datatools'];
  assert.equal(entry.id, 'pydata');
  assert.equal(entry.kind, 'project');
  assert.deepEqual(entry.requires, ['python']);
  const retired = await read('retired.json');
  assert.equal(retired['slicc-py-datatools'], undefined);
  const manifest = await read('projects/pydata/package.json');
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    '@ai-ecoverse/py-matplotlib',
    '@ai-ecoverse/py-numpy',
    '@ai-ecoverse/py-pandas',
  ]);
  const lock = await readFile(new URL('projects/pydata/pnpm-lock.yaml', optional), 'utf8');
  const packages = lock.slice(lock.indexOf('\npackages:\n'), lock.indexOf('\nsnapshots:\n'));
  const locked = [...packages.matchAll(/^ {2}'(@ai-ecoverse\/[^@']+)@([^']+)':$/gm)].map(
    ([, name, version]) => [name, version]
  );
  const numpys = locked.filter(([name]) => name === '@ai-ecoverse/py-numpy');
  assert.deepEqual(numpys, [
    ['@ai-ecoverse/py-numpy', manifest.dependencies['@ai-ecoverse/py-numpy']],
  ]);
  assert.ok(+numpys[0][1].match(/^2\.3\.2-(\d+)$/)[1] >= 12, 'numpy has the LinAlgError fix');
  assert.deepEqual(lock.match(/@ai-ecoverse\/wasix-python.*/g), [
    "@ai-ecoverse/wasix-python': '-'",
  ]);
  assert.ok(!lock.includes('py-scipy'), 'scipy stays out until it is certified');
  const certs = JSON.parse(await readFile(new URL('../certs.json', optional), 'utf8'));
  const withdrawn = Object.keys(certs).filter((key) => {
    const numpy = key.match(/^@ai-ecoverse\/py-numpy@2\.3\.2-(\d+)$/);
    const pandas = key.match(/^@ai-ecoverse\/py-pandas@2\.3\.2-(\d+)$/);
    return (
      key.startsWith('@ai-ecoverse/py-scipy@') ||
      (numpy && +numpy[1] >= 4 && +numpy[1] <= 10) ||
      (pandas && +pandas[1] >= 5 && +pandas[1] <= 11)
    );
  });
  assert.deepEqual(withdrawn, []);
});

test('uv, esbuild, tsc and buf are withdrawn until attested rebuilds (homescoop#864): retired rows, no pins and no certs, while git and gh are certified CI builds with no exception', async () => {
  const catalog = await read('catalog.json');
  const { dependencies } = await read('package.json');
  const retired = await read('retired.json');
  const certs = JSON.parse(await readFile(new URL('../certs.json', optional), 'utf8'));
  for (const [name, id] of [
    ['@ai-ecoverse/wasix-uv-shim', 'uv'],
    ['@ai-ecoverse/wasi-esbuild', 'esbuild'],
    ['@ai-ecoverse/wasi-typescript', 'tsc'],
    ['@ai-ecoverse/wasi-buf', 'buf'],
  ]) {
    assert.equal(catalog[name], undefined, name);
    assert.equal(dependencies[name], undefined, name);
    assert.equal(retired[name]?.id, id, name);
    assert.deepEqual(
      Object.keys(certs).filter((key) => key.startsWith(`${name}@`)),
      [],
      name
    );
  }
  for (const name of ['@ai-ecoverse/wasm-git', '@ai-ecoverse/wasi-gh']) {
    assert.ok(catalog[name], name);
    const entry = certs[`${name}@${dependencies[name]}`];
    assert.match(entry?.sha256 ?? '', /^[0-9a-f]{64}$/, name);
    assert.equal(entry.exception, undefined, name);
  }
});
