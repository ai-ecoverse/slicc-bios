import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

const SHIPPED_AT_ROOT = ['@ai-ecoverse/slicc-spectrum'];

test('a package whose shipped code the unit tests load from the root is pinned at the root as in the base set', async () => {
  const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const base = JSON.parse(await read('package.json')).dependencies;
  for (const name of SHIPPED_AT_ROOT) {
    assert.ok(base[name], `${name} is in the base set`);
    assert.equal(
      root.devDependencies[name],
      base[name],
      `${name}: root ${root.devDependencies[name]}, base set ${base[name]}`
    );
  }
});

function parts(version) {
  const [main, ...pre] = version.split('-');
  return [...main.split('.').map(Number), pre.length ? pre.join('-') : null];
}

function compare(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1;
  if (y[3] === null) return -1;
  return x[3] < y[3] ? -1 : 1;
}

const caret = (clause) => {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(clause);
  if (!match) return [clause];
  const [, major, minor, patch] = match.map(Number);
  const upper =
    major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
  return [`>=${major}.${minor}.${patch}`, `<${upper}`];
};

export function satisfies(version, range) {
  return range
    .trim()
    .split(/\s+/)
    .flatMap(caret)
    .every((clause) => {
      const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2}(?:-[\w.]+)?)$/.exec(clause);
      assert.ok(match, `unsupported range clause "${clause}" in "${range}"`);
      const [, op = '=', bound] = match;
      const d = compare(version, bound);
      return { '>=': d >= 0, '<=': d <= 0, '>': d > 0, '<': d < 0, '=': d === 0 }[op];
    });
}

test('the pinned slicc-kernel satisfies every pinned package’s engines and peers', async () => {
  const kernel = JSON.parse(await read('package.json')).dependencies[KERNEL];
  const wanted = [];
  for (const file of ['package-lock.json']) {
    for (const [path, entry] of Object.entries(JSON.parse(await read(file)).packages)) {
      if (!path) continue;
      const name = `${file} ${path.split('node_modules/').at(-1)}@${entry.version}`;
      const range = entry.engines?.['slicc-kernel'];
      if (range) wanted.push([name, range]);
      const peer = entry.peerDependencies?.[KERNEL];
      if (peer) wanted.push([`${name} (peer)`, peer]);
    }
  }
  for (const file of ['pnpm-lock.yaml', 'agent/pnpm-lock.yaml', 'tailscale/pnpm-lock.yaml']) {
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

const SPECTRUM = '@ai-ecoverse/slicc-spectrum';

test('the agent’s slicc-spectrum peer range accepts the base set’s slicc-spectrum, so page and agent agree on one spectrum', async () => {
  const spectrum = JSON.parse(await read('package.json')).dependencies[SPECTRUM];
  const agent = JSON.parse(await read('agent/package-lock.json')).packages[
    'node_modules/@ai-ecoverse/slicc-agent'
  ];
  const range = agent.peerDependencies?.[SPECTRUM];
  assert.ok(range, `slicc-agent ${agent.version} names a slicc-spectrum peer`);
  assert.ok(
    satisfies(spectrum, range),
    `slicc-agent ${agent.version} wants slicc-spectrum ${range}, the base set has ${spectrum}`
  );
});

test('the range check reads the forms the packages use', () => {
  assert.equal(satisfies('1.47.1', '>=1.44.0'), true);
  assert.equal(satisfies('1.100.0', '^1.98.0'), true);
  assert.equal(satisfies('1.96.1', '^1.98.0'), false);
  assert.equal(satisfies('2.0.0', '^1.98.0'), false);
  assert.equal(satisfies('0.3.1', '^0.3.0'), true);
  assert.equal(satisfies('0.4.0', '^0.3.0'), false);
  assert.equal(satisfies('1.43.1', '>=1.44.0'), false);
  assert.equal(satisfies('1.47.1', '>=1.26.3 <2'), true);
  assert.equal(satisfies('2.0.0', '>=1.26.3 <2'), false);
  assert.equal(satisfies('1.47.1', '1.47.1'), true);
  assert.equal(satisfies('1.48.0-rc.1', '>=1.48.0'), false);
  assert.equal(satisfies('1.48.0', '>=1.48.0-rc.1'), true);
  assert.equal(satisfies('1.48.0-rc.2', '>=1.48.0-rc.1'), true);
  assert.equal(satisfies('1.48.0-rc.1', '1.48.0-rc.1'), true);
  assert.throws(() => satisfies('1.0.0', '~1.0.0'), /unsupported range clause/);
});

const GATED =
  /^@ai-ecoverse\/(slicc-kernel|slicc-cdp|slicc-clipboard|slicc-jsh|mcpcat$|wasi-|wasix-|wasm-|py-)/;

async function lockedGated() {
  const found = new Map();
  for (const file of ['package-lock.json']) {
    for (const [path, entry] of Object.entries(JSON.parse(await read(file)).packages)) {
      const name = path.split('node_modules/').at(-1);
      if (path && GATED.test(name)) found.set(`${name}@${entry.version}`, [file, entry.integrity]);
    }
  }
  const projects = (await readdir(new URL('optional/projects/', packages)).catch(() => [])).map(
    (id) => `optional/projects/${id}/pnpm-lock.yaml`
  );
  for (const file of [
    'pnpm-lock.yaml',
    'agent/pnpm-lock.yaml',
    'tailscale/pnpm-lock.yaml',
    ...projects,
  ]) {
    for (const [, name, version, integrity] of (await read(file)).matchAll(
      /^ {2}'?(@ai-ecoverse\/[^@'\s]+)@([^'(\s]+)'?:\n {4}resolution: \{integrity: ([^,}\s]+)/gm
    )) {
      if (GATED.test(name)) found.set(`${name}@${version}`, [file, integrity]);
    }
  }
  return found;
}

const SERVED = new URL('../../src/', import.meta.url);
const served = (name) => readFile(new URL(name, SERVED), 'utf8');

test('the runtime union (certs.json and every lockfile seven ships, Tailscale and the catalog projects included) covers every gated pin with its integrity', async (t) => {
  const { certifiedSet } = await import('../../src/seed/layer.js');
  const certified = await certifiedSet(served);
  const found = await lockedGated();
  assert.ok(found.size >= 30, `found ${found.size} gated packages`);
  const missing = [...found]
    .filter(([key, [, integrity]]) => certified[key]?.integrity !== integrity)
    .map(([key, [file]]) => `${file} ${key}`);
  assert.deepEqual(missing, [], 'neither in src/packages/certs.json nor in a lockfile seven ships');
  const certs = JSON.parse(await read('certs.json'));
  for (const [key, entry] of Object.entries(certs)) {
    assert.match(key, /^@ai-ecoverse\/[\w.-]+@\d+\.\d+\.\d+(-[\w.-]+)?$/, key);
    assert.match(entry.integrity, /^sha512-/, key);
    if (entry.sha256) assert.match(entry.sha256, /^[0-9a-f]{64}$/, key);
    if ('exception' in entry) assert.match(entry.exception, /\(homescoop#\d+/, key);
  }
  t.diagnostic(`pins: PASS ${found.size} packages`);
});

test("a user's gated version is untested unless certs.json or seven's own lockfiles carry it with that integrity", async () => {
  const { untested } = await import('../../src/seed/layer.js');
  const lock = (rows) =>
    `lockfileVersion: '9.0'\n\npackages:\n\n${rows.map(([key, integrity]) => `  '${key}':\n    resolution: {integrity: ${integrity}}\n`).join('\n')}`;
  const files = {
    'packages/certs.json': JSON.stringify({
      '@ai-ecoverse/wasm-a@1.0.0': { integrity: 'sha512-a' },
    }),
    'packages/pnpm-lock.yaml': lock([['@ai-ecoverse/wasm-b@2.0.0', 'sha512-b']]),
    'packages/package-lock.json': JSON.stringify({
      packages: {
        '': {},
        'node_modules/@ai-ecoverse/wasm-c': { version: '3.0.0', integrity: 'sha512-c' },
      },
    }),
  };
  const { certifiedSet } = await import('../../src/seed/layer.js');
  const certs = () =>
    certifiedSet(async (name) => {
      if (!(name in files)) throw new Error(`404 ${name}`);
      return files[name];
    });
  const user = lock([
    ['@ai-ecoverse/wasm-a@1.0.0', 'sha512-a'],
    ['@ai-ecoverse/wasm-b@2.0.0', 'sha512-b'],
    ['@ai-ecoverse/wasm-c@3.0.0', 'sha512-c'],
    ['@ai-ecoverse/wasm-b@2.0.1', 'sha512-b1'],
    ['@ai-ecoverse/wasm-c@3.0.0-x', 'sha512-other'],
  ]);
  assert.deepEqual(
    await untested(
      user,
      lock([]),
      certs,
      async () => new Set(),
      async () => []
    ),
    ['@ai-ecoverse/wasm-b@2.0.1', '@ai-ecoverse/wasm-c@3.0.0-x']
  );
  const swapped = lock([['@ai-ecoverse/wasm-b@2.0.0', 'sha512-forged']]);
  assert.deepEqual(
    await untested(
      swapped,
      lock([]),
      certs,
      async () => new Set(),
      async () => []
    ),
    ['@ai-ecoverse/wasm-b@2.0.0'],
    'the same version with other bytes is untested'
  );
});

test('every test run keeps slicc-cdp off 127.0.0.1:9222-9229', async () => {
  const harness = await readFile(
    new URL('../../test/integration/chrome.mjs', import.meta.url),
    'utf8'
  );
  assert.match(harness, /^env\.SLICC_CDP_PORTS \?\?= '9300-9309';$/m);
});

const EXCEPTIONS = {
  repo: 'ai-ecoverse/homescoop',
  path: 'certification-exceptions.json',
  ref: '78d41d0ab6757deba5db295fffa6e3f358cd1a9e',
};

test("the bundled copy of homescoop's certification exceptions is byte for byte homescoop's at the pinned commit", async () => {
  const { repo, path, ref } = EXCEPTIONS;
  assert.match(ref, /^[0-9a-f]{40}$/);
  const bundled = await read('optional/exceptions.json');
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, url);
  assert.equal(
    bundled,
    await response.text(),
    `bump src/packages/optional/exceptions.json to ${url}`
  );
  const { exceptionsOf } = await import('../../src/seed/packages.js');
  assert.ok(exceptionsOf(JSON.parse(bundled))?.length > 10, 'and the page reads it as schema 1');
});

const BUILDERS = {
  'slicc-kernel': 'slicc-kernel',
  'slicc-jsh': 'slicc-jsh',
  'slicc-cdp': 'slicc-cdp',
  'slicc-clipboard': 'slicc-clipboard',
  mcpcat: 'mcpcat',
  'wasi-slicc': 'slicc-cli',
  'wasm-tailscale': 'wasm-tailscale',
};

function builderOf(name) {
  const short = name.replace(/^@ai-ecoverse\//, '');
  return BUILDERS[short] ?? (/^(wasm|wasi|wasix|py)-/.test(short) ? 'homescoop' : null);
}

async function deprecationOf(name, version) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, url);
  return (await response.json()).deprecated ?? null;
}

async function provenanceOf(name, version) {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace('/', '%2f')}@${encodeURIComponent(version)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (response.status === 404) return null;
  assert.equal(response.status, 200, url);
  for (const attestation of (await response.json()).attestations ?? []) {
    if (!/slsa\.dev\/provenance/.test(attestation.predicateType ?? '')) continue;
    const statement = JSON.parse(
      Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8')
    );
    const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
    return {
      repository: workflow.repository,
      path: workflow.path,
      ref: workflow.ref,
      subjects: (statement.subject ?? []).map((subject) => subject.digest?.sha512),
    };
  }
  return null;
}

test('every gated pin is a release its own repository built from main, with npm provenance for that tarball, not deprecated on npm, and homescoop withdrew none', async (t) => {
  const { exceptionsOf, ruled } = await import('../../src/seed/packages.js');
  const exceptions = exceptionsOf(JSON.parse(await read('optional/exceptions.json')));
  assert.ok(exceptions, "bios's copy of homescoop's certification exceptions is schema 1");
  const found = await lockedGated();
  const pins = new Set(found.keys());
  const wrong = [];
  await Promise.all(
    [...found].map(async ([key, [file, integrity]]) => {
      const at = key.lastIndexOf('@');
      const [name, version] = [key.slice(0, at), key.slice(at + 1)];
      const repo = builderOf(name);
      if (!repo) return wrong.push(`${file} ${key}: no repository is known to build it`);
      const built = await provenanceOf(name, version);
      const hex = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
      if (!built) wrong.push(`${file} ${key}: no npm provenance`);
      else if (
        built.repository !== `https://github.com/ai-ecoverse/${repo}` ||
        built.ref !== 'refs/heads/main'
      )
        wrong.push(
          `${file} ${key}: built by ${built.repository} ${built.path} at ${built.ref}, not ai-ecoverse/${repo} at main`
        );
      else if (!built.subjects.includes(hex))
        wrong.push(`${file} ${key}: the provenance names another tarball than the lockfile's`);
      const deprecated = await deprecationOf(name, version);
      if (deprecated) wrong.push(`${file} ${key}: deprecated on npm: ${deprecated}`);
      const withdrawn = repo === 'homescoop' && ruled(exceptions, name, version, pins);
      if (withdrawn) wrong.push(`${file} ${key}: ${withdrawn}`);
    })
  );
  assert.deepEqual(wrong.sort(), []);
  t.diagnostic(`provenance: PASS ${found.size} gated pins`);
});
