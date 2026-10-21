import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { offered as latest } from './catalog.mjs';
import { launch } from './chrome.mjs';

const optional = new URL('../../src/packages/optional/', import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, optional), 'utf8'));

const KEYS = new Set([
  'id',
  'label',
  'kind',
  'requires',
  'notes',
  'range',
  'abi',
  'helpers',
  'source',
  'description',
  'commands',
  'size',
  'replaces',
]);

const HOMESCOOPED = /^@ai-ecoverse\/(?:wasm|wasi|wasix|py)-/;

test('the optional catalog lists packages and pins none: no package.json or lockfile, and each package entry keeps only what npm can’t tell', async () => {
  for (const file of ['package.json', 'package-lock.json'])
    await assert.rejects(readFile(new URL(file, optional)), { code: 'ENOENT' }, file);
  const catalog = await read('catalog.json');
  const retired = await read('retired.json');
  for (const [name, entry] of Object.entries(catalog)) {
    for (const key of Object.keys(entry)) assert.ok(KEYS.has(key), `${name}: ${key}`);
    if (entry.kind === 'project') continue;
    assert.match(name, /^@ai-ecoverse\/[a-z0-9][\w.-]*$/, name);
    for (const key of ['description', 'commands', 'size', 'version'])
      assert.equal(entry[key], undefined, `${name}: npm gives its ${key}`);
    for (const note of entry.notes ?? [])
      assert.ok(typeof note === 'string' && note.length > 10 && note.length <= 300, name);
    for (const helper of entry.helpers ?? []) assert.match(helper, /^[\w.+-]+$/, name);
    for (const gone of entry.replaces ?? [])
      assert.ok(Object.hasOwn(retired, gone), `${name} replaces ${gone}, which isn't retired`);
    if (entry.source) {
      assert.match(entry.source.repo, /^ai-ecoverse\/[\w.-]+$/, name);
      assert.match(entry.source.workflow, /^\.github\/workflows\/[\w.-]+\.ya?ml$/, name);
    } else assert.match(name, HOMESCOOPED, `${name} is homescoop's, from its ladder at main`);
  }
  assert.deepEqual(await read('sources.json'), { '@ai-ecoverse/slicc-cdp': { certified: 'tag' } });
  const named = Object.entries(catalog).filter(([, entry]) => entry.source);
  assert.deepEqual(
    Object.fromEntries(
      named.map(([name, entry]) => [name, `${entry.source.repo} ${entry.source.workflow}`])
    ),
    {
      '@ai-ecoverse/wasi-slicc': 'ai-ecoverse/slicc-cli .github/workflows/release.yml',
      '@ai-ecoverse/slicc-jsh': 'ai-ecoverse/slicc-jsh .github/workflows/release.yml',
      '@ai-ecoverse/sliccy-browser':
        'ai-ecoverse/slicc-cdp .github/workflows/publish-sliccy-browser.yml',
      '@ai-ecoverse/mcpcat': 'ai-ecoverse/mcpcat .github/workflows/release.yml',
    },
    'every other package is homescoop’s, from its ladder at main'
  );
});

test('every catalog entry has a unique id and a label, and requires only other entries without cycles; a project keeps its description, commands and size', async () => {
  const entries = Object.values(await read('catalog.json'));
  const ids = entries.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of entries) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(entry.label, entry.id);
    if (entry.kind === 'project') {
      assert.ok(entry.description, entry.id);
      assert.deepEqual(entry.commands, [], entry.id);
      assert.ok(Number.isInteger(entry.size) && entry.size > 0, entry.id);
    }
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

test('the published package carries the catalog, its sources and the bundled exceptions, and no optional pins', async () => {
  const { files } = JSON.parse(await readFile(new URL('../../../package.json', optional), 'utf8'));
  for (const file of ['catalog.json', 'sources.json', 'exceptions.json'])
    assert.ok(files.includes(`src/packages/optional/${file}`), file);
  assert.ok(!files.some((file) => /optional\/package(-lock)?\.json$/.test(file)));
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
    assert.match(lock, /^overrides:\n(?: {2}.+\n)*? {2}'@ai-ecoverse\/wasix-python': '-'$/m);
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
  const offered = await latest('@ai-ecoverse/wasm-libheif');
  assert.equal((await heif()).version, offered);
  await run(
    page,
    'clear; heif-convert --version 2>&1 | head -1 | grep -c 1.23.6 | sed "s/^/heif ran /"'
  );
  await shows(page, 'heif ran 1');
  assert.deepEqual(page.errors, []);
});

test('Python data tools are homescoop’s attested CI builds for the catalog’s Python 3.15: one project of numpy, pandas, matplotlib and scipy that locks one copy of every package, dateutil and tzdata at what pandas pins, no pytz and no Python of its own, and no decertified numpy or pandas certified', async () => {
  const catalog = await read('catalog.json');
  const entry = catalog['slicc-py-datatools'];
  assert.equal(entry.id, 'pydata');
  assert.equal(entry.kind, 'project');
  assert.deepEqual(entry.requires, ['python']);
  const retired = await read('retired.json');
  assert.equal(retired['slicc-py-datatools'], undefined);
  const manifest = await read('projects/pydata/package.json');
  assert.deepEqual(Object.keys(manifest.dependencies), [
    '@ai-ecoverse/py-matplotlib',
    '@ai-ecoverse/py-numpy',
    '@ai-ecoverse/py-pandas',
    '@ai-ecoverse/py-scipy',
  ]);
  assert.match(manifest.dependencies['@ai-ecoverse/py-numpy'], /^2\.5\.4-\d+$/);
  assert.match(manifest.dependencies['@ai-ecoverse/py-pandas'], /^3\.0\.\d+-\d+$/);
  assert.equal(catalog['@ai-ecoverse/wasix-python'].range, '3.15.0');
  assert.equal(catalog['@ai-ecoverse/wasix-python'].abi, 'cp315');
  const lock = await readFile(new URL('projects/pydata/pnpm-lock.yaml', optional), 'utf8');
  const packages = lock.slice(lock.indexOf('\npackages:\n'), lock.indexOf('\nsnapshots:\n'));
  const locked = [...packages.matchAll(/^ {2}'(@ai-ecoverse\/[^@']+)@([^']+)':$/gm)].map(
    ([, name, version]) => [name, version]
  );
  const names = locked.map(([name]) => name);
  assert.deepEqual(
    names.filter((name, at) => names.indexOf(name) !== at),
    [],
    'one copy of every package'
  );
  const version = Object.fromEntries(locked);
  for (const [name, pinned] of Object.entries(manifest.dependencies))
    assert.equal(version[name], pinned, name);
  assert.equal(version['@ai-ecoverse/py-pytz'], undefined);
  assert.deepEqual(lock.match(/@ai-ecoverse\/wasix-python.*/g), [
    "@ai-ecoverse/wasix-python': '-'",
  ]);
  const snapshots = lock.slice(lock.indexOf('\nsnapshots:\n'));
  const needs = (name) => {
    const block = snapshots.match(
      new RegExp(
        `\\n {2}'${name}@${version[name].replaceAll('.', '\\.')}':\\n {4}dependencies:\\n((?: {6}.*\\n)*)`
      )
    );
    return Object.fromEntries(
      [...(block?.[1] ?? '').matchAll(/^ {6}'([^']+)': (\S+)$/gm)].map(([, dep, at]) => [dep, at])
    );
  };
  const pandas = needs('@ai-ecoverse/py-pandas');
  for (const name of ['@ai-ecoverse/py-python-dateutil', '@ai-ecoverse/py-tzdata'])
    assert.equal(pandas[name], version[name], `${name} is what pandas pins`);
  for (const name of [
    '@ai-ecoverse/py-scipy',
    '@ai-ecoverse/py-pandas',
    '@ai-ecoverse/py-matplotlib',
  ])
    assert.equal(
      needs(name)['@ai-ecoverse/py-numpy'],
      version['@ai-ecoverse/py-numpy'],
      `${name} is on the one numpy`
    );
  const certs = JSON.parse(await readFile(new URL('../certs.json', optional), 'utf8'));
  const withdrawn = Object.keys(certs).filter((key) => {
    const numpy = key.match(/^@ai-ecoverse\/py-numpy@2\.3\.2-(\d+)$/);
    const pandas = key.match(/^@ai-ecoverse\/py-pandas@2\.3\.2-(\d+)$/);
    return (
      (numpy && +numpy[1] >= 4 && +numpy[1] <= 10) ||
      (pandas && +pandas[1] >= 5 && +pandas[1] <= 11)
    );
  });
  assert.deepEqual(withdrawn, []);
});

test('uv, esbuild, tsc and buf are withdrawn until attested rebuilds (homescoop#864): retired rows, not listed and no certs, while git and gh are homescoop’s, gated as its ladder builds', async () => {
  const catalog = await read('catalog.json');
  const retired = await read('retired.json');
  const certs = JSON.parse(await readFile(new URL('../certs.json', optional), 'utf8'));
  for (const [name, id] of [
    ['@ai-ecoverse/wasix-uv-shim', 'uv'],
    ['@ai-ecoverse/wasi-esbuild', 'esbuild'],
    ['@ai-ecoverse/wasi-typescript', 'tsc'],
    ['@ai-ecoverse/wasi-buf', 'buf'],
  ]) {
    assert.equal(catalog[name], undefined, name);
    assert.equal(retired[name]?.id, id, name);
    assert.deepEqual(
      Object.keys(certs).filter((key) => key.startsWith(`${name}@`)),
      [],
      name
    );
  }
  for (const name of ['@ai-ecoverse/wasm-git', '@ai-ecoverse/wasi-gh']) {
    assert.ok(catalog[name], name);
    assert.equal(catalog[name].source, undefined, `${name} is homescoop's`);
  }
});
