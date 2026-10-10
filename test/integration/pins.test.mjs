import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const packages = new URL('../../src/packages/', import.meta.url);
const read = async (path) => readFile(new URL(path, packages), 'utf8');
const KERNEL = '@ai-ecoverse/slicc-kernel';

test('/opt/agent pins the same slicc-kernel as the base set, and pnpm resolves only that one', async () => {
  const base = JSON.parse(await read('package.json')).dependencies[KERNEL];
  const agent = JSON.parse(await read('agent/package.json')).dependencies[KERNEL];
  assert.ok(base);
  assert.equal(agent, base);
  const resolved = [
    ...(await read('agent/pnpm-lock.yaml')).matchAll(
      /^ {2}'@ai-ecoverse\/slicc-kernel@([^']+)':$/gm
    ),
  ].map(([, version]) => version);
  assert.deepEqual([...new Set(resolved)], [base]);
});

function parts(version) {
  const [main, ...pre] = version.split('-');
  return [...main.split('.').map(Number), pre.length ? pre.join('-') : null];
}

function compare(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export function satisfies(version, range) {
  return range
    .trim()
    .split(/\s+/)
    .every((clause) => {
      const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(clause);
      assert.ok(match, `unsupported range clause "${clause}" in "${range}"`);
      const [, op = '=', bound] = match;
      const d = compare(version, bound);
      return { '>=': d >= 0, '<=': d <= 0, '>': d > 0, '<': d < 0, '=': d === 0 }[op];
    });
}

test('the pinned slicc-kernel satisfies every pinned package’s engines and peers', async () => {
  const kernel = JSON.parse(await read('package.json')).dependencies[KERNEL];
  const wanted = [];
  for (const file of ['package-lock.json', 'optional/package-lock.json']) {
    for (const [path, entry] of Object.entries(JSON.parse(await read(file)).packages)) {
      const range = entry.engines?.['slicc-kernel'];
      if (path && range)
        wanted.push([`${file} ${path.split('node_modules/').at(-1)}@${entry.version}`, range]);
    }
  }
  for (const file of ['pnpm-lock.yaml', 'agent/pnpm-lock.yaml']) {
    const text = await read(file);
    for (const [, name, range] of text.matchAll(
      /^ {2}'?([^\s':]+)'?:\n(?: {4}.*\n)*? {4}engines: \{[^}]*slicc-kernel: '([^']+)'/gm
    )) {
      wanted.push([`${file} ${name}`, range]);
    }
    for (const [, name, range] of text.matchAll(
      /^ {2}'?([^\s':]+)'?:\n(?: {4}.*\n)*? {4}peerDependencies:\n(?: {6}.*\n)*? {6}'@ai-ecoverse\/slicc-kernel': '([^']+)'/gm
    )) {
      wanted.push([`${file} ${name} (peer)`, range]);
    }
  }
  assert.ok(wanted.length >= 10, `found ${wanted.length} kernel requirements`);
  assert.ok(
    wanted.some(([what]) => /slicc-agent@.*\(peer\)$/.test(what)),
    'the agent’s kernel peer is checked'
  );
  const unmet = wanted.filter(([, range]) => !satisfies(kernel, range));
  assert.deepEqual(unmet, [], `slicc-kernel ${kernel} doesn't satisfy these`);
});

test('the range check reads the forms the packages use', () => {
  assert.equal(satisfies('1.47.1', '>=1.44.0'), true);
  assert.equal(satisfies('1.43.1', '>=1.44.0'), false);
  assert.equal(satisfies('1.47.1', '>=1.26.3 <2'), true);
  assert.equal(satisfies('2.0.0', '>=1.26.3 <2'), false);
  assert.equal(satisfies('1.47.1', '1.47.1'), true);
  assert.throws(() => satisfies('1.0.0', '^1.0.0'), /unsupported range clause/);
});
