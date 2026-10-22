import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { untested } from '../../src/seed/layer.js';
import {
  CACHE,
  createNpm,
  describe,
  LIVE_EXCEPTIONS,
  look,
  MISMATCH,
  offeredNow,
  readCache,
  refusal,
  registry,
  TIMEOUT,
  withNpm,
  writeCache,
} from '../../src/seed/packages.js';

const REGISTRY = 'https://registry.npmjs.org/';
const SLSA = 'https://slsa.dev/provenance/v1';
const HOMESCOOP = 'ai-ecoverse/homescoop';
const LADDER = '.github/workflows/ladder-build.yml';
const KERNEL = '@ai-ecoverse/slicc-kernel';
const bundled = JSON.parse(
  await readFile(new URL('../../src/packages/optional/exceptions.json', import.meta.url), 'utf8')
);

const integrityOf = (key) =>
  `sha512-${createHash('sha512').update(`tarball of ${key}`).digest('base64')}`;
const hexOf = (integrity) => Buffer.from(integrity.slice(7), 'base64').toString('hex');

function fakeNpm(releases, { live = null, tags = {}, failing = new Set() } = {}) {
  const asked = [];
  const byKey = new Map(releases.map((one) => [`${one.name}@${one.version}`, one]));
  const doc = (one) => ({
    name: one.name,
    version: one.version,
    description: one.description ?? `${one.name} for slicc`,
    ...(one.dependencies ? { dependencies: one.dependencies } : {}),
    ...(one.engines ? { engines: one.engines } : {}),
    ...(one.deprecated ? { deprecated: one.deprecated } : {}),
    slicc: { ...(one.slicc ?? {}), commands: one.commands ?? { [one.name.split('-').pop()]: {} } },
    dist: {
      integrity: one.served ?? integrityOf(`${one.name}@${one.version}`),
      unpackedSize: one.size ?? 1000,
      ...(one.provenance === false
        ? {}
        : {
            attestations: {
              url: `${REGISTRY}-/npm/v1/attestations/${one.name.replace('/', '%2f')}@${one.version}`,
              provenance: { predicateType: SLSA },
            },
          }),
    },
  });
  const statement = (one) => {
    const built = { repository: HOMESCOOP, path: LADDER, ref: 'refs/heads/main', ...one.built };
    const subject = one.subject ?? integrityOf(`${one.name}@${one.version}`);
    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: `pkg:npm/${one.name.replace('@', '%40')}@${one.version}`,
          digest: { sha512: hexOf(subject) },
        },
      ],
      predicateType: SLSA,
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: { ...built, repository: `https://github.com/${built.repository}` },
          },
        },
      },
    };
  };
  const respond = (body, status = 200) =>
    new Response(body === null ? 'not found' : JSON.stringify(body), {
      status: body === null ? 404 : status,
    });
  const fetcher = async (url, init = {}) => {
    asked.push({ url, accept: init.headers?.accept ?? null });
    if (failing.has(url)) throw new TypeError('Failed to fetch');
    if (url === LIVE_EXCEPTIONS) return live ? respond(live) : respond({}, 503);
    const path = decodeURIComponent(new URL(url).pathname).slice(1);
    const attested = path.match(/^-\/npm\/v1\/attestations\/(.+)$/);
    if (attested) {
      const one = byKey.get(attested[1]);
      if (!one) return respond(null);
      const payload = Buffer.from(JSON.stringify(statement(one))).toString('base64');
      return respond({
        attestations: [{ predicateType: SLSA, bundle: { dsseEnvelope: { payload } } }],
      });
    }
    const named = releases.filter((one) => path === one.name || path.startsWith(`${one.name}/`));
    if (!named.length) return respond(null);
    const { name } = named[0];
    const rest = path.slice(name.length + 1);
    if (!rest) {
      const versions = Object.fromEntries(named.map((one) => [one.version, doc(one)]));
      const latest = named.findLast((one) => !one.notLatest)?.version;
      return respond({ name, 'dist-tags': { latest, ...tags[name] }, versions });
    }
    if (rest === 'latest') {
      const one = named.findLast((release) => !release.notLatest);
      return respond(doc(one));
    }
    const one = byKey.get(`${name}@${rest}`);
    return respond(one ? doc(one) : null);
  };
  return { fetcher, asked };
}

const CDP_RELEASE = { repository: 'ai-ecoverse/slicc-cdp', path: '.github/workflows/release.yml' };
const GIT = { name: '@ai-ecoverse/wasm-git', version: '2.55.0-18' };
const BASH = { name: '@ai-ecoverse/wasm-bash', version: '5.3.0-19' };
const base = new Map([
  [`${BASH.name}@${BASH.version}`, integrityOf(`${BASH.name}@${BASH.version}`)],
  ['left-pad@1.3.0', integrityOf('left-pad@1.3.0')],
]);
const have = { [KERNEL]: '1.129.0' };

function gate(releases, options = {}) {
  const npm = fakeNpm(releases, options);
  const sources = {
    '@ai-ecoverse/slicc-cdp': {
      repo: 'ai-ecoverse/slicc-cdp',
      workflow: '.github/workflows/release.yml',
    },
    '@ai-ecoverse/sliccy-browser': {
      repo: 'ai-ecoverse/slicc-cdp',
      workflow: '.github/workflows/publish-sliccy-browser.yml',
    },
    ...options.sources,
  };
  return {
    ...npm,
    npm: createNpm({ base, sources, bundled, have, fetcher: npm.fetcher }),
  };
}

const lockOf = (...keys) =>
  new Map(keys.map((key) => (Array.isArray(key) ? key : [key, integrityOf(key)])));
const key = ({ name, version }) => `${name}@${version}`;

test('the gate admits a homescoop release from its ladder at main, a dependency the base set locks with that integrity, a non-ai-ecoverse dependency the base set locks, and a slicc-cdp on its provenance with no certified dist-tag', async () => {
  const cdp = { name: '@ai-ecoverse/slicc-cdp', version: '1.30.13' };
  const browser = { name: '@ai-ecoverse/sliccy-browser', version: '0.1.30' };
  const { npm } = gate(
    [
      { ...GIT, dependencies: { [BASH.name]: BASH.version } },
      { ...cdp, built: CDP_RELEASE },
      {
        ...browser,
        built: {
          repository: 'ai-ecoverse/slicc-cdp',
          path: '.github/workflows/publish-sliccy-browser.yml',
        },
      },
    ],
    { tags: { [cdp.name]: { certified: '1.30.11' } } }
  );
  assert.equal(await npm.gate(lockOf(key(GIT), key(BASH), 'left-pad@1.3.0'), key(GIT)), null);
  assert.equal(await npm.gate(lockOf(key(browser), key(cdp)), key(browser)), null);
});

test('the gate refuses drift: a locked integrity that isn’t npm’s, a version npm doesn’t have, a package pnpm didn’t install', async () => {
  const { npm } = gate([GIT]);
  const swapped = lockOf([key(GIT), integrityOf('something else')]);
  assert.deepEqual(await npm.gate(swapped, key(GIT)), {
    why: "wasm-git 2.55.0-18 doesn't match npm's build",
    drift: true,
  });
  assert.deepEqual(await npm.gate(lockOf(key(GIT), '@ai-ecoverse/wasm-bash@5.3.0-99'), key(GIT)), {
    why: "npm doesn't have wasm-bash 5.3.0-99",
  });
  assert.deepEqual(await npm.gate(lockOf(key(BASH)), key(GIT)), {
    why: "pnpm didn't install wasm-git 2.55.0-18",
  });
  const changed = lockOf([`${BASH.name}@${BASH.version}`, integrityOf('forged bash')]);
  assert.match((await npm.gate(new Map([...lockOf(key(GIT)), ...changed]), key(GIT))).why, /bash/);
});

test('the gate refuses a dependency from outside ai-ecoverse unless the base set locks it', async () => {
  const { npm } = gate([GIT]);
  assert.deepEqual(await npm.gate(lockOf(key(GIT), 'left-pad@1.3.1'), key(GIT)), {
    why: "left-pad@1.3.1 isn't one of seven's own packages",
  });
});

test('the gate refuses a release without npm provenance, built by another repo, by another workflow, from a branch, or whose attestation names another tarball', async () => {
  const cases = [
    [{ provenance: false }, 'wasm-git 2.55.0-18 has no build provenance'],
    [
      { built: { repository: 'someone/homescoop' } },
      "wasm-git 2.55.0-18 wasn't built by ai-ecoverse/homescoop",
    ],
    [
      { built: { path: '.github/workflows/manual.yml' } },
      "wasm-git 2.55.0-18 wasn't built by ai-ecoverse/homescoop's release workflow on main",
    ],
    [
      { built: { ref: 'refs/heads/try-this' } },
      "wasm-git 2.55.0-18 wasn't built by ai-ecoverse/homescoop's release workflow on main",
    ],
    [
      { subject: integrityOf('another tarball') },
      "wasm-git 2.55.0-18 wasn't built by ai-ecoverse/homescoop",
    ],
  ];
  for (const [change, why] of cases) {
    const { npm } = gate([{ ...GIT, ...change }]);
    assert.deepEqual(await npm.gate(lockOf(key(GIT)), key(GIT)), { why }, JSON.stringify(change));
  }
  const { npm } = gate([{ ...GIT, built: { path: '.github/workflows/publish.yml' } }]);
  assert.equal(await npm.gate(lockOf(key(GIT)), key(GIT)), null, 'publish.yml is homescoop’s too');
});

test('the gate refuses a package whose publisher seven doesn’t know, and a slicc-cdp without provenance even at its certified dist-tag', async () => {
  const stranger = { name: '@ai-ecoverse/new-thing', version: '1.0.0' };
  const cdp = { name: '@ai-ecoverse/slicc-cdp', version: '1.30.13', provenance: false };
  const { npm } = gate([stranger, cdp], { tags: { [cdp.name]: { certified: '1.30.13' } } });
  assert.deepEqual(await npm.gate(lockOf(key(stranger)), key(stranger)), {
    why: 'new-thing has no publisher seven knows',
  });
  assert.deepEqual(await npm.gate(lockOf(key(cdp)), key(cdp)), {
    why: 'slicc-cdp 1.30.13 has no build provenance',
  });
});

test('the gate refuses a version npm marks deprecated, whoever built it, and admits the same release once it isn’t', async () => {
  const cdp = { name: '@ai-ecoverse/slicc-cdp', version: '1.30.13', built: CDP_RELEASE };
  const why = 'superseded; use >=1.30.25';
  for (const one of [GIT, cdp]) {
    const it = key(one);
    const { npm } = gate([{ ...one, deprecated: why }]);
    const name = one.name.slice(13);
    assert.deepEqual(await npm.gate(lockOf(it), it), {
      why: `${name} ${one.version} is deprecated on npm: ${why}`,
    });
    assert.equal(await gate([one]).npm.gate(lockOf(it), it), null, it);
  }
});

test('a throw anywhere in the check refuses, never passes: npm’s version answer, the attestation fetch, and a certs.json match whose npm answer throws', async () => {
  const it = key(GIT);
  const version = `${REGISTRY}${GIT.name}/${encodeURIComponent(GIT.version)}`;
  const attestation = `${REGISTRY}-/npm/v1/attestations/${GIT.name.replace('/', '%2f')}@${GIT.version}`;
  for (const url of [version, attestation]) {
    const { npm } = gate([GIT], { failing: new Set([url]) });
    assert.deepEqual(await npm.gate(lockOf(it), it), {
      why: `couldn't check ${it} on npm (Failed to fetch)`,
    });
  }
  const entry = { id: 'git', label: 'git', package: GIT.name };
  const listing = gate([GIT], { failing: new Set([attestation]) }).npm;
  const info = (await listing.lookAll([entry], new Map())).get(GIT.name);
  assert.ok(!info || info.withheld, 'a listing whose attestation fetch throws offers nothing');
  const exact = { name: '@ai-ecoverse/wasi-slicc', version: '1.44.7' };
  const at = `${REGISTRY}${exact.name}/${exact.version}`;
  const { npm } = gate([exact], { failing: new Set([at]) });
  const lock = `lockfileVersion: '9.0'\n\npackages:\n\n  '${key(exact)}':\n    resolution: {integrity: ${integrityOf(key(exact))}}\n`;
  const certs = async () => ({ [key(exact)]: { integrity: integrityOf(key(exact)) } });
  const none = async () => new Set();
  assert.deepEqual(
    await untested(lock, `lockfileVersion: '9.0'\n`, certs, none, (keys, all) =>
      npm.denied(keys, all)
    ),
    [key(exact)]
  );
});

test('homescoop’s certification exceptions deny: the bundled copy always, the live one too, and a live file can never grant', async () => {
  const numpy = { name: '@ai-ecoverse/py-numpy', version: '2.3.2-5' };
  const fresh = { name: '@ai-ecoverse/py-numpy', version: '2.5.4-1' };
  const denied =
    'py-numpy 2.3.2-5 was withdrawn (https://github.com/ai-ecoverse/homescoop/issues/826)';
  const empty = { schema: 1, entries: [] };
  for (const live of [null, empty, { schema: 2, entries: 'everything is fine' }]) {
    const { npm } = gate([numpy], { live });
    assert.deepEqual(await npm.gate(lockOf(key(numpy)), key(numpy)), { why: denied });
  }
  const ruling = {
    package: fresh.name,
    versions: [fresh.version],
    verdict: 'fail',
    issue: 'https://github.com/ai-ecoverse/homescoop/issues/9999',
  };
  const { npm } = gate([fresh], { live: { schema: 1, entries: [ruling] } });
  assert.deepEqual(await npm.gate(lockOf(key(fresh)), key(fresh)), {
    why: 'py-numpy 2.5.4-1 was withdrawn (https://github.com/ai-ecoverse/homescoop/issues/9999)',
  });
  const quiet = gate([fresh]);
  assert.equal(await quiet.npm.gate(lockOf(key(fresh)), key(fresh)), null, 'live unreachable');
});

test('an exception’s requires must be met by what the lock and the base set pin, and a release whose engines reject seven’s kernel is refused', async () => {
  const live = {
    schema: 1,
    entries: [
      {
        package: GIT.name,
        range: '>=2.55.0-18',
        verdict: 'requires',
        requires: { [BASH.name]: '>=5.3.0-20' },
        issue: 'https://github.com/ai-ecoverse/homescoop/issues/1',
      },
    ],
  };
  const { npm } = gate([GIT], { live });
  assert.deepEqual(await npm.gate(lockOf(key(GIT), key(BASH)), key(GIT)), {
    why: 'wasm-git 2.55.0-18 needs wasm-bash 5.3.0-20 or newer (https://github.com/ai-ecoverse/homescoop/issues/1)',
  });
  const picky = gate([{ ...GIT, engines: { 'slicc-kernel': '>=1.200.0' } }]);
  assert.deepEqual(await picky.npm.gate(lockOf(key(GIT)), key(GIT)), {
    why: 'needs slicc-kernel 1.200.0 or newer',
  });
});

test('the listing takes the version, description, commands without helpers and the unpacked size from npm’s latest, and withholds a release whose exact dependency isn’t certified', async () => {
  const commands = {
    git: {},
    scalar: {},
    'git-shell': {},
    'git-upload-pack': { helper: true },
    '../evil': {},
  };
  const cdp = { name: '@ai-ecoverse/slicc-cdp', version: '1.30.13', provenance: false };
  const browser = {
    name: '@ai-ecoverse/sliccy-browser',
    version: '0.1.30',
    dependencies: { [cdp.name]: cdp.version },
    built: {
      repository: 'ai-ecoverse/slicc-cdp',
      path: '.github/workflows/publish-sliccy-browser.yml',
    },
  };
  const { npm, fetcher } = gate(
    [
      { ...GIT, version: '2.55.0-17' },
      { ...GIT, commands, description: 'Git for slicc', size: 55748565 },
      cdp,
      browser,
    ],
    { tags: { [cdp.name]: { certified: '1.30.13' } } }
  );
  const entries = [
    { id: 'git', label: 'git', package: GIT.name, helpers: ['git-shell'] },
    { id: 'jsh-browser', label: 'Browser', package: browser.name },
    { id: 'gone', label: 'Gone', package: '@ai-ecoverse/wasm-gone' },
  ];
  const found = await npm.lookAll(entries, new Map());
  assert.deepEqual(found.get(GIT.name), {
    version: '2.55.0-18',
    integrity: integrityOf(key(GIT)),
    description: 'Git for slicc',
    commands: ['git', 'scalar'],
    size: 55748565,
  });
  assert.equal(found.get(browser.name).version, '0.1.30');
  assert.equal(found.get(browser.name).withheld, 'slicc-cdp 1.30.13 has no build provenance');
  assert.equal(found.get('@ai-ecoverse/wasm-gone'), null, 'a failed row is null, the rest load');
  assert.ok(fetcher, 'the fake answered');
});

test('a ranged entry offers the highest version whose X.Y.Z is in range, -N builds included, never a deprecated one or a newer Python, and withholds one built for another ABI', async () => {
  const name = '@ai-ecoverse/wasix-python';
  const releases = [
    ['3.14.2-29'],
    ['3.15.0-1'],
    ['3.15.0-2'],
    ['3.15.0-3'],
    ['3.15.0-4', { deprecated: 'broken' }],
    ['3.15.1-1'],
    ['3.16.0-1'],
  ].map(([version, extra]) => ({
    name,
    version,
    slicc: { python: { abi: `cp${version.split('.').slice(0, 2).join('')}` } },
    ...extra,
  }));
  const { npm, asked } = gate(releases);
  const entry = { id: 'python', label: 'Python', package: name, range: '3.15.0', abi: 'cp315' };
  const found = await npm.lookAll([entry], new Map());
  assert.equal(found.get(name).version, '3.15.0-3');
  assert.equal(found.get(name).withheld, undefined);
  assert.ok(
    asked.some(({ url, accept }) => url === `${REGISTRY}${name}` && /install-v1/.test(accept)),
    'the abbreviated packument'
  );
  const wide = await npm.lookAll([{ ...entry, range: '~3.15.0' }], new Map());
  assert.equal(wide.get(name).version, '3.15.1-1');
  const other = await npm.lookAll([{ ...entry, abi: 'cp316' }], new Map());
  assert.equal(other.get(name).withheld, "wasix-python 3.15.0-3 isn't built for cp316");
  const none = await npm.lookAll([{ ...entry, range: '3.17.0' }], new Map());
  assert.deepEqual(none.get(name), { version: null, withheld: 'npm has no Python in 3.17.0' });
});

test('every npm request has a timeout, and a passing provenance verdict is remembered for the listing but never a refusal', async () => {
  const seen = [];
  const { fetcher } = fakeNpm([GIT]);
  const timed = (url, init) => {
    seen.push(init.signal);
    return fetcher(url, init);
  };
  const ctx = {
    npm: registry(timed),
    base,
    sources: {},
    have,
    exceptions: [],
    verdicts: new Map(),
  };
  await look({ id: 'git', label: 'git', package: GIT.name }, ctx);
  assert.ok(seen.length >= 2 && seen.every((signal) => signal instanceof AbortSignal));
  assert.ok(TIMEOUT <= 30000);
  assert.deepEqual([...ctx.verdicts], [[`${key(GIT)} ${integrityOf(key(GIT))}`, null]]);
  const before = seen.length;
  await look({ id: 'git', label: 'git', package: GIT.name }, { ...ctx, npm: registry(timed) });
  assert.equal(seen.length, before + 1, 'only the latest doc again, no attestation');
  const refused = { ...ctx, npm: registry(fakeNpm([{ ...GIT, provenance: false }]).fetcher) };
  refused.verdicts = new Map();
  await look({ id: 'git', label: 'git', package: GIT.name }, refused);
  assert.deepEqual([...refused.verdicts], []);
});

test('a row with no npm data offers nothing to install: checking, then unreachable with Retry; a withheld row says why; npm data marks the size unpacked', () => {
  const entry = { id: 'git', label: 'git', package: GIT.name, requires: [], notes: ['A caveat.'] };
  const checking = describe(withNpm(entry, undefined, 'checking'), null, undefined);
  assert.deepEqual(
    [checking.state, checking.registry, checking.offered, checking.description, checking.actions],
    ['available', 'checking', null, '', []]
  );
  assert.deepEqual(checking.notes, ['A caveat.']);
  const down = describe(withNpm(entry, undefined, 'unreachable'), null, undefined);
  assert.deepEqual([down.registry, down.actions], ['unreachable', ['retry']]);
  const installed = describe(withNpm(entry, undefined, 'unreachable'), '2.55.0-1', undefined);
  assert.deepEqual([installed.state, installed.actions], ['installed', ['remove']]);
  const info = { version: '2.55.0-18', description: 'Git', commands: ['git'], size: 5 };
  const offered = describe(withNpm(entry, info), null, undefined);
  assert.deepEqual(
    [offered.offered, offered.size, offered.unpacked, offered.registry, offered.actions],
    ['2.55.0-18', 5, true, undefined, ['install']]
  );
  const outdated = describe(withNpm(entry, info), '2.55.0-1', undefined);
  assert.deepEqual([outdated.state, outdated.actions], ['outdated', ['update', 'remove']]);
  const newer = describe(withNpm(entry, info), '2.56.0-1', undefined);
  assert.deepEqual([newer.state, newer.actions], ['installed', ['remove']], 'never a downgrade');
  const why = 'needs slicc-kernel 1.200.0 or newer';
  const withheld = describe(withNpm(entry, { ...info, withheld: why }), '2.55.0-1', undefined);
  assert.deepEqual(
    [withheld.state, withheld.offered, withheld.withheld, withheld.newer, withheld.actions],
    ['installed', '2.55.0-1', undefined, { version: '2.55.0-18', reason: why }, ['remove']],
    'an installed row names the newer version it can’t take, and is never withheld'
  );
  const ahead = describe(withNpm(entry, { ...info, withheld: why }), '2.56.0-1', undefined);
  assert.deepEqual(
    [ahead.offered, ahead.newer, ahead.withheld],
    ['2.56.0-1', undefined, undefined]
  );
  const fresh = describe(withNpm(entry, { ...info, withheld: why }), null, undefined);
  assert.deepEqual(
    [fresh.state, fresh.offered, fresh.withheld, fresh.actions],
    ['available', null, why, []]
  );
  const fallback = { ...info, version: '2.55.0-17', newer: { version: '2.55.0-18', reason: why } };
  const older = describe(withNpm(entry, fallback), null, undefined);
  assert.deepEqual(
    [older.offered, older.newer, older.actions],
    ['2.55.0-17', fallback.newer, ['install']]
  );
});

test('a refusal reads “Not offered: …”, drift keeps MISMATCH, and an update keeps the version it had', () => {
  assert.equal(refusal({ why: 'x', drift: true }, 'git', null), MISMATCH);
  assert.equal(
    refusal({ why: 'x', drift: true }, 'git', '2.55.0-1'),
    "This version doesn't match the tested build, so git 2.55.0-1 stays. Retry later."
  );
  assert.equal(
    refusal({ why: 'wasm-git 2.55.0-18 has no build provenance' }, 'git', null),
    'Not offered: wasm-git 2.55.0-18 has no build provenance.'
  );
  assert.equal(
    refusal({ why: 'needs slicc-kernel 1.200.0 or newer' }, 'git', '2.55.0-1'),
    'Not offered: needs slicc-kernel 1.200.0 or newer. git 2.55.0-1 stays.'
  );
});

test("a user's layer takes a catalog package the npm gate admits, with its pinned dependency, and nothing else the gate didn't check", async () => {
  const lock = (rows) =>
    `lockfileVersion: '9.0'\n\npackages:\n\n${rows.map(([one, integrity]) => `  '${one}':\n    resolution: {integrity: ${integrity}}\n`).join('\n')}`;
  const certs = async () => ({});
  const { npm } = gate([
    { ...GIT, dependencies: { [BASH.name]: '5.3.0-21' } },
    { ...BASH, version: '5.3.0-21' },
    { name: '@ai-ecoverse/wasm-tar', version: '1.35.0-9' },
  ]);
  const names = new Set([GIT.name]);
  const admit = (left, all) => npm.admitted(left, all, names);
  const user = lock([
    [key(GIT), integrityOf(key(GIT))],
    [`${BASH.name}@5.3.0-21`, integrityOf(`${BASH.name}@5.3.0-21`)],
    ['@ai-ecoverse/wasm-tar@1.35.0-9', integrityOf('@ai-ecoverse/wasm-tar@1.35.0-9')],
  ]);
  assert.deepEqual(await untested(user, lock([]), certs, admit), [
    '@ai-ecoverse/wasm-tar@1.35.0-9',
  ]);
  const forged = lock([[key(GIT), integrityOf('forged')]]);
  assert.deepEqual(await untested(forged, lock([]), certs, admit), [key(GIT)]);
});

test('homescoop’s exceptions deny an exact match from the base set or certs.json too', async () => {
  const numpy = { name: '@ai-ecoverse/py-numpy', version: '2.3.2-5' };
  const exact = new Map([[key(numpy), integrityOf(key(numpy))]]);
  const npm = createNpm({
    base: exact,
    sources: {},
    bundled,
    have,
    fetcher: fakeNpm([]).fetcher,
  });
  assert.deepEqual(await npm.gate(lockOf(key(numpy)), key(numpy)), {
    why: 'py-numpy 2.3.2-5 was withdrawn (https://github.com/ai-ecoverse/homescoop/issues/826)',
  });
});

test('when latest fails the gate, the listing offers the newest older version that passes, checking at most five, and names latest’s blocker', async () => {
  const cdp = { name: '@ai-ecoverse/slicc-cdp', provenance: false };
  const built = {
    repository: 'ai-ecoverse/slicc-cdp',
    path: '.github/workflows/publish-sliccy-browser.yml',
  };
  const browser = (version, dep, extra = {}) => ({
    name: '@ai-ecoverse/sliccy-browser',
    version,
    dependencies: { [cdp.name]: dep },
    built,
    ...extra,
  });
  const entry = { id: 'jsh-browser', label: 'Browser', package: '@ai-ecoverse/sliccy-browser' };
  const releases = [
    { ...cdp, version: '1.30.10', provenance: undefined, built: CDP_RELEASE },
    { ...cdp, version: '1.30.13' },
    browser('0.1.28', '1.30.10'),
    browser('0.1.29', '1.30.10'),
    browser('0.1.30', '1.30.13'),
  ];
  const tags = { tags: { [cdp.name]: { certified: '1.30.13' } } };
  const found = (await gate(releases, tags).npm.lookAll([entry], new Map())).get(entry.package);
  assert.equal(found.version, '0.1.29');
  assert.equal(found.withheld, undefined);
  assert.deepEqual(found.newer, {
    version: '0.1.30',
    reason: 'slicc-cdp 1.30.13 has no build provenance',
  });
  const blocked = [
    { ...cdp, version: '1.30.13' },
    browser('0.1.23', '1.30.10'),
    ...['0.1.24', '0.1.25', '0.1.26', '0.1.27', '0.1.28'].map((v) => browser(v, '1.30.13')),
    browser('0.1.29', '1.30.13', { deprecated: 'oops' }),
    browser('0.1.30', '1.30.13'),
    { ...cdp, version: '1.30.10' },
  ];
  const none = (await gate(blocked, tags).npm.lookAll([entry], new Map())).get(entry.package);
  assert.equal(none.version, '0.1.30');
  assert.equal(none.withheld, 'slicc-cdp 1.30.13 has no build provenance');
  assert.equal(none.newer, undefined, '0.1.23 is past the five it checks');
});

test('in Your packages, a certs.json exact match that homescoop’s bundled or live exceptions deny is untested too', async () => {
  const numpy = { name: '@ai-ecoverse/py-numpy', version: '2.3.2-5' };
  const lock = (rows) =>
    `lockfileVersion: '9.0'\n\npackages:\n\n${rows.map(([one, integrity]) => `  '${one}':\n    resolution: {integrity: ${integrity}}\n`).join('\n')}`;
  const certs = async () => ({
    [key(numpy)]: { integrity: integrityOf(key(numpy)) },
    [key(BASH)]: { integrity: integrityOf(key(BASH)) },
  });
  const { npm } = gate([]);
  const user = lock([
    [key(numpy), integrityOf(key(numpy))],
    [key(BASH), integrityOf(key(BASH))],
  ]);
  const none = async () => new Set();
  const rule = (keys, all) => npm.denied(keys, all);
  assert.deepEqual(await untested(user, lock([]), certs, none, rule), [key(numpy)]);
  const live = {
    schema: 1,
    entries: [{ package: BASH.name, versions: [BASH.version], verdict: 'fail', issue: 'x#1' }],
  };
  const withdrawn = gate([], { live }).npm;
  assert.deepEqual(
    await untested(user, lock([]), certs, none, (keys, all) => withdrawn.denied(keys, all)),
    [key(numpy), key(BASH)],
    'a historic certs.json build that homescoop’s live file withdraws is refused'
  );
  const failing = async () => {
    throw new Error('no catalog');
  };
  assert.deepEqual(
    await untested(user, lock([]), certs, none, failing),
    [key(numpy), key(BASH)],
    'exceptions it can’t read refuse, never pass'
  );
});

test('in Your packages, a certs.json exact match npm marks deprecated, such as wasi-slicc 1.41.0, is untested too, and so is one npm can’t answer for', async () => {
  const old = { name: '@ai-ecoverse/wasi-slicc', version: '1.41.0', deprecated: 'superseded' };
  const fine = { name: '@ai-ecoverse/wasi-slicc', version: '1.44.7' };
  const gone = { name: '@ai-ecoverse/wasi-slicc', version: '1.44.8' };
  const lock = (rows) =>
    `lockfileVersion: '9.0'\n\npackages:\n\n${rows.map(([one, integrity]) => `  '${one}':\n    resolution: {integrity: ${integrity}}\n`).join('\n')}`;
  const certs = async () =>
    Object.fromEntries(
      [old, fine, gone].map((one) => [key(one), { integrity: integrityOf(key(one)) }])
    );
  const catalog = JSON.parse(await readFile(new URL('catalog.json', OPTIONAL), 'utf8'));
  const { npm } = gate([old, fine], { sources: { [old.name]: catalog[old.name].source } });
  const user = lock([old, fine, gone].map((one) => [key(one), integrityOf(key(one))]));
  const none = async () => new Set();
  assert.deepEqual(
    await untested(user, lock([]), certs, none, (keys, all) => npm.denied(keys, all)),
    [key(old), key(gone)]
  );
});

function fakeRoot(files = {}) {
  const dir = (prefix) => ({
    getDirectoryHandle: async (name) => dir(`${prefix}${name}/`),
    getFileHandle: async (name, { create } = {}) => {
      const path = `${prefix}${name}`;
      if (!(path in files) && !create) throw new Error('NotFoundError');
      return {
        getFile: async () => ({ text: async () => files[path] }),
        createWritable: async () => ({
          write: async (data) => {
            files[path] = data;
          },
          close: async () => {},
        }),
      };
    },
  });
  return { root: dir(''), files };
}

test('the OPFS cache keeps only what the rows show: a provenance verdict planted there is never read, and none is written', async () => {
  const planted = {
    schema: 1,
    entries: { [GIT.name]: { version: GIT.version, description: 'Git' } },
    verdicts: { [`${key(GIT)} ${integrityOf(key(GIT))}`]: null },
  };
  const { root, files } = fakeRoot({ [CACHE]: JSON.stringify(planted) });
  const read = await readCache(root);
  assert.deepEqual([...read], [[GIT.name, { version: GIT.version, description: 'Git' }]]);
  await writeCache(root, read);
  assert.deepEqual(Object.keys(JSON.parse(files[CACHE])), ['schema', 'entries']);
  const { npm } = gate([{ ...GIT, provenance: false }]);
  const found = await npm.lookAll([{ id: 'git', label: 'git', package: GIT.name }], new Map());
  assert.equal(found.get(GIT.name).withheld, 'wasm-git 2.55.0-18 has no build provenance');
});

test('an exception’s requires reads the kernel seven ships, never certs.json’s history', async () => {
  const bash = { name: BASH.name, version: '5.3.0-20' };
  const kernelAt = (version) => `${KERNEL}@${version}`;
  const shipped = new Map([[kernelAt('1.131.0'), integrityOf(kernelAt('1.131.0'))]]);
  const exact = new Map([...shipped, [kernelAt('1.53.3'), integrityOf(kernelAt('1.53.3'))]]);
  const { fetcher } = fakeNpm([bash]);
  const npm = createNpm({ base: exact, shipped, sources: {}, bundled, have, fetcher });
  assert.equal(await npm.gate(lockOf(key(bash)), key(bash)), null);
  const old = new Map([[kernelAt('1.129.0'), integrityOf(kernelAt('1.129.0'))]]);
  const behind = createNpm({ base: old, shipped: old, sources: {}, bundled, have, fetcher });
  assert.match(
    (await behind.gate(lockOf(key(bash)), key(bash))).why,
    /needs slicc-kernel 1\.130\.2/
  );
});

test('Install and Update take the version npm offers now, never the cached one, so a planted cache can’t pick another ABI or an older release', async () => {
  const name = '@ai-ecoverse/wasix-python';
  const releases = ['3.15.0-2', '3.15.0-3', '3.16.0-1'].map((version) => ({
    name,
    version,
    slicc: { python: { abi: `cp${version.split('.').slice(0, 2).join('')}` } },
  }));
  const { npm } = gate(releases);
  const listed = {
    id: 'python',
    label: 'Python',
    package: name,
    requires: [],
    range: '3.15.0',
    abi: 'cp315',
  };
  const planted = withNpm(listed, { version: '3.16.0-1', description: 'x', commands: [] });
  assert.equal(planted.offered, '3.16.0-1');
  const live = await offeredNow(npm, planted);
  assert.equal(live.offered, '3.15.0-3');
  const down = { ...npm, offer: async () => Promise.reject(new Error('offline')) };
  await assert.rejects(offeredNow(down, planted), (error) =>
    /Couldn't reach npm for Python's version/.test(error.plain)
  );
});
test('the walk-back skips an older version with no valid integrity and still offers the next one that passes', async () => {
  const name = '@ai-ecoverse/wasm-xxd';
  const { npm } = gate([
    { name, version: '9.2.1192-1' },
    { name, version: '9.2.1192-2', served: 'md5-broken' },
    { name, version: '9.2.1192-3', provenance: false },
  ]);
  const found = await npm.lookAll([{ id: 'xxd', label: 'xxd', package: name }], new Map());
  assert.equal(found.get(name).version, '9.2.1192-1');
  assert.deepEqual(found.get(name).newer, {
    version: '9.2.1192-3',
    reason: 'wasm-xxd 9.2.1192-3 has no build provenance',
  });
});

const OPTIONAL = new URL('../../src/packages/optional/', import.meta.url);
const CLI = { repository: 'ai-ecoverse/slicc-cli', path: '.github/workflows/release.yml' };
const PUBLISHERS = {
  '@ai-ecoverse/slicc-jsh': {
    id: 'node',
    versions: ['0.52.1', '0.52.2'],
    built: { repository: 'ai-ecoverse/slicc-jsh', path: '.github/workflows/release.yml' },
  },
  '@ai-ecoverse/mcpcat': {
    id: 'mcpcat',
    versions: ['0.18.0', '0.18.1'],
    built: { repository: 'ai-ecoverse/mcpcat', path: '.github/workflows/release.yml' },
  },
  '@ai-ecoverse/wasi-slicc': { id: 'slicc', versions: ['1.47.1', '1.47.2'], built: CLI },
  '@ai-ecoverse/sliccy-browser': {
    id: 'jsh-browser',
    versions: ['0.1.40', '0.1.41'],
    built: {
      repository: 'ai-ecoverse/slicc-cdp',
      path: '.github/workflows/publish-sliccy-browser.yml',
    },
  },
};
const CDP = { name: '@ai-ecoverse/slicc-cdp', version: '1.30.30', built: CDP_RELEASE };

function releasesOf(name, change = {}) {
  const { versions, built } = PUBLISHERS[name];
  const deps = name.endsWith('sliccy-browser') ? { dependencies: { [CDP.name]: CDP.version } } : {};
  return versions.map((version, i) => ({
    name,
    version,
    built,
    ...deps,
    ...(i === versions.length - 1 ? change : {}),
  }));
}

async function shipped(releases, options = {}) {
  const { fetcher, asked } = fakeNpm(releases, options);
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const at = new URL(url);
    if (at.protocol !== 'file:') return real(url, init);
    return readFile(at).then(
      (body) => new Response(body),
      () => new Response('not found', { status: 404 })
    );
  };
  try {
    const { loadCatalog } = await import('../../src/seed/packages.js');
    const catalog = await loadCatalog(OPTIONAL, { fetcher });
    const byName = new Map(catalog.entries.map((entry) => [entry.package, entry]));
    return { ...catalog, byName, asked };
  } finally {
    globalThis.fetch = real;
  }
}

test('with no optional pins, the catalog names the publishers of slicc-jsh, mcpcat, wasi-slicc and sliccy-browser, and seven offers each at npm’s latest when its provenance passes', async () => {
  const names = Object.keys(PUBLISHERS);
  const releases = [CDP, ...names.flatMap((name) => releasesOf(name))];
  const { npm, byName, asked } = await shipped(releases);
  for (const file of ['package.json', 'package-lock.json'])
    assert.ok(!asked.some(({ url }) => url.endsWith(`/optional/${file}`)), file);
  const entries = names.map((name) => byName.get(name));
  for (const entry of entries) assert.equal(entry.pin, undefined, entry.package);
  const found = await npm.lookAll(entries, new Map());
  for (const name of names) {
    const latest = PUBLISHERS[name].versions.at(-1);
    const info = found.get(name);
    assert.deepEqual(
      [info.version, info.withheld, info.newer],
      [latest, undefined, undefined],
      name
    );
    const it = `${name}@${latest}`;
    const lock = name.endsWith('sliccy-browser') ? lockOf(it, key(CDP)) : lockOf(it);
    assert.equal(await npm.gate(lock, it), null, name);
  }
});

test('a new publisher’s release built by another repo, another workflow or a maintenance branch isn’t offered: the row lists it and offers the newest release that passes', async () => {
  const cases = [
    [{ repository: 'someone/fork' }, (it, repo) => `${it} wasn't built by ${repo}`],
    [
      { path: '.github/workflows/manual.yml' },
      (it, repo) => `${it} wasn't built by ${repo}'s release workflow on main`,
    ],
    [
      { ref: 'refs/heads/release-0.x' },
      (it, repo) => `${it} wasn't built by ${repo}'s release workflow on main`,
    ],
    [{ provenance: false }, (it) => `${it} has no build provenance`],
  ];
  for (const [name, { versions, built }] of Object.entries(PUBLISHERS)) {
    for (const [change, why] of cases) {
      const bad = 'provenance' in change ? change : { built: { ...built, ...change } };
      const { npm, byName } = await shipped([CDP, ...releasesOf(name, bad)]);
      const [good, latest] = versions;
      const reason = why(`${name.slice(13)} ${latest}`, built.repository);
      const info = (await npm.lookAll([byName.get(name)], new Map())).get(name);
      assert.deepEqual(
        [info.version, info.newer],
        [good, { version: latest, reason }],
        `${name} ${JSON.stringify(change)}`
      );
      const it = `${name}@${latest}`;
      const lock = name.endsWith('sliccy-browser') ? lockOf(it, key(CDP)) : lockOf(it);
      assert.deepEqual(await npm.gate(lock, it), { why: reason }, name);
    }
  }
});

test('wasi-slicc, slicc-jsh and mcpcat built by their own ci.yml on main, the shared pipeline, are offered like their release.yml builds, while one built by another workflow isn’t', async () => {
  for (const name of ['@ai-ecoverse/wasi-slicc', '@ai-ecoverse/slicc-jsh', '@ai-ecoverse/mcpcat']) {
    const { versions, built } = PUBLISHERS[name];
    const [good, latest] = versions;
    const pipeline = await shipped(
      releasesOf(name, { built: { ...built, path: '.github/workflows/ci.yml' } })
    );
    const info = (await pipeline.npm.lookAll([pipeline.byName.get(name)], new Map())).get(name);
    assert.deepEqual([info.version, info.newer], [latest, undefined], name);
    assert.equal(
      await pipeline.npm.gate(lockOf(`${name}@${latest}`), `${name}@${latest}`),
      null,
      name
    );
    const other = await shipped(
      releasesOf(name, { built: { ...built, path: '.github/workflows/publish.yml' } })
    );
    const found = (await other.npm.lookAll([other.byName.get(name)], new Map())).get(name);
    const reason = `${name.slice(13)} ${latest} wasn't built by ${built.repository}'s release workflow on main`;
    assert.deepEqual([found.version, found.newer], [good, { version: latest, reason }], name);
  }
});

test('a release npm marks deprecated is never offered, from latest, the walk-back or an exact match in certs.json: wasi-slicc 1.44.4 and everything before 1.44.1, and a deprecated mcpcat latest', async () => {
  const name = '@ai-ecoverse/wasi-slicc';
  const why = 'superseded; use >=1.47.3';
  const releases = [
    { name, version: '1.41.0', built: CLI, deprecated: why, notLatest: true },
    ...['1.44.0', '1.44.3', '1.44.4'].map((version) => ({
      name,
      version,
      built: CLI,
      ...(version === '1.44.3' ? {} : { deprecated: why }),
    })),
  ];
  const { npm, byName, certified: exact } = await shipped(releases);
  const info = (await npm.lookAll([byName.get(name)], new Map())).get(name);
  assert.deepEqual(
    [info.version, info.newer],
    ['1.44.3', { version: '1.44.4', reason: `wasi-slicc 1.44.4 is deprecated on npm: ${why}` }]
  );
  assert.deepEqual(await npm.gate(lockOf(`${name}@1.44.0`), `${name}@1.44.0`), {
    why: `wasi-slicc 1.44.0 is deprecated on npm: ${why}`,
  });
  const old = `${name}@1.41.0`;
  assert.ok(exact.has(old), 'certs.json has 1.41.0');
  assert.deepEqual(await npm.gate(new Map([[old, exact.get(old)]]), old), {
    why: `wasi-slicc 1.41.0 is deprecated on npm: ${why}`,
  });
  const row = describe(withNpm(byName.get(name), info), '1.41.0', null);
  assert.deepEqual(
    [row.state, row.version, row.offered, row.actions],
    ['outdated', '1.41.0', '1.44.3', ['update', 'remove']],
    'a profile on the deprecated 1.41.0 is offered the newest release that passes as its update'
  );
  const theirs = describe(withNpm(byName.get(name), info), null, null, [
    { version: '1.41.0', where: '/home/.local/share/pnpm', user: 'cone', manager: 'pnpm' },
  ]);
  assert.deepEqual(
    [theirs.state, theirs.offered, theirs.actions],
    ['outdated', '1.44.3', ['update']]
  );
  const mcpcat = '@ai-ecoverse/mcpcat';
  const dropped = await shipped(releasesOf(mcpcat, { deprecated: 'broken stdio' }));
  const listed = (await dropped.npm.lookAll([dropped.byName.get(mcpcat)], new Map())).get(mcpcat);
  assert.deepEqual(
    [listed.version, listed.newer],
    ['0.18.0', { version: '0.18.1', reason: 'mcpcat 0.18.1 is deprecated on npm: broken stdio' }]
  );
});

test('sliccy-browser is offered only with a slicc-cdp from slicc-cdp’s release workflow that npm doesn’t deprecate, whatever its certified tag says, and only from slicc-cdp’s sliccy-browser workflow; the new publishers meet homescoop’s exceptions and the kernel’s engines too', async () => {
  const browser = '@ai-ecoverse/sliccy-browser';
  const tagged = { tags: { [CDP.name]: { certified: CDP.version } } };
  const untagged = await shipped([CDP, ...releasesOf(browser)]);
  const fine = (await untagged.npm.lookAll([untagged.byName.get(browser)], new Map())).get(browser);
  assert.deepEqual([fine.version, fine.withheld], ['0.1.41', undefined]);
  const bare = { ...CDP, built: undefined, provenance: false };
  const off = await shipped([bare, ...releasesOf(browser)], tagged);
  const info = (await off.npm.lookAll([off.byName.get(browser)], new Map())).get(browser);
  assert.equal(info.withheld, 'slicc-cdp 1.30.30 has no build provenance');
  const elsewhere = [
    [
      { ref: `refs/tags/v${CDP.version}` },
      "wasn't built by ai-ecoverse/slicc-cdp's release workflow on main",
    ],
    [
      { path: '.github/workflows/manual.yml' },
      "wasn't built by ai-ecoverse/slicc-cdp's release workflow on main",
    ],
    [{ repository: 'someone/slicc-cdp' }, "wasn't built by ai-ecoverse/slicc-cdp"],
  ];
  for (const [change, why] of elsewhere) {
    const moved = await shipped(
      [{ ...CDP, built: { ...CDP_RELEASE, ...change } }, ...releasesOf(browser)],
      tagged
    );
    const row = (await moved.npm.lookAll([moved.byName.get(browser)], new Map())).get(browser);
    assert.equal(row.withheld, `slicc-cdp 1.30.30 ${why}`, JSON.stringify(change));
  }
  const old = await shipped([{ ...CDP, deprecated: 'use 1.31' }, ...releasesOf(browser)], tagged);
  const held = (await old.npm.lookAll([old.byName.get(browser)], new Map())).get(browser);
  assert.equal(held.withheld, 'slicc-cdp 1.30.30 is deprecated on npm: use 1.31');
  const cdpRelease = { repository: 'ai-ecoverse/slicc-cdp', path: '.github/workflows/release.yml' };
  const wrong = await shipped([CDP, ...releasesOf(browser, { built: cdpRelease })]);
  const it = `${browser}@0.1.41`;
  assert.deepEqual(await wrong.npm.gate(lockOf(it, key(CDP)), it), {
    why: "sliccy-browser 0.1.41 wasn't built by ai-ecoverse/slicc-cdp's release workflow on main",
  });
  const mcpcat = '@ai-ecoverse/mcpcat';
  const live = {
    schema: 1,
    entries: [
      {
        package: mcpcat,
        versions: ['0.18.1'],
        verdict: 'fail',
        issue: 'https://github.com/ai-ecoverse/mcpcat/issues/1',
      },
    ],
  };
  const ruled = await shipped(releasesOf(mcpcat), { live });
  const withdrawn = (await ruled.npm.lookAll([ruled.byName.get(mcpcat)], new Map())).get(mcpcat);
  assert.deepEqual(
    [withdrawn.version, withdrawn.newer],
    [
      '0.18.0',
      {
        version: '0.18.1',
        reason: 'mcpcat 0.18.1 was withdrawn (https://github.com/ai-ecoverse/mcpcat/issues/1)',
      },
    ]
  );
  const jsh = '@ai-ecoverse/slicc-jsh';
  const picky = await shipped(releasesOf(jsh, { engines: { 'slicc-kernel': '>=99.0.0' } }));
  const later = `${jsh}@0.52.2`;
  assert.deepEqual(await picky.npm.gate(lockOf(later), later), {
    why: 'needs slicc-kernel 99.0.0 or newer',
  });
});

test('a homescoop latest that homescoop’s bundled exceptions withdraw isn’t offered: the listing offers the newest release they allow', async () => {
  const name = '@ai-ecoverse/py-numpy';
  const { npm } = gate([
    { name, version: '2.3.2-3' },
    { name, version: '2.3.2-5' },
  ]);
  const found = await npm.lookAll([{ id: 'numpy', label: 'numpy', package: name }], new Map());
  const info = found.get(name);
  assert.deepEqual(
    [info.version, info.withheld, info.newer],
    [
      '2.3.2-3',
      undefined,
      {
        version: '2.3.2-5',
        reason:
          'py-numpy 2.3.2-5 was withdrawn (https://github.com/ai-ecoverse/homescoop/issues/826)',
      },
    ]
  );
});

test('a lock entry with no registry integrity (a git or tarball dependency) is refused, never skipped', async () => {
  const { installedLock } = await import('../../src/seed/packages.js');
  const text = `lockfileVersion: '9.0'\n\npackages:\n\n  '${key(GIT)}':\n    resolution: {integrity: ${integrityOf(key(GIT))}}\n\n  'evil@https://example.com/evil.tgz':\n    resolution: {tarball: https://example.com/evil.tgz}\n\n  '@ai-ecoverse/wasm-x@git+https://github.com/x/y.git#abc':\n    resolution: {type: git, repo: x}\n\nsnapshots:\n\n  '${key(GIT)}': {}\n`;
  const lock = installedLock(text);
  assert.deepEqual([...lock.keys()].sort(), [
    '@ai-ecoverse/wasm-git@2.55.0-18',
    '@ai-ecoverse/wasm-x@git+https://github.com/x/y.git#abc',
    'evil@https://example.com/evil.tgz',
  ]);
  const { npm } = gate([GIT]);
  assert.deepEqual(await npm.gate(lock, key(GIT)), {
    why: "evil@https://example.com/evil.tgz isn't a registry tarball with an integrity",
  });
});

test('two entries whose latest claim the same command: the first in the catalog keeps it, the other is withheld', async () => {
  const { collided } = await import('../../src/seed/packages.js');
  const entries = [
    { id: 'zip', label: 'zip', package: 'a' },
    { id: 'other', label: 'other', package: 'b' },
    { id: 'none', label: 'none', package: 'c' },
  ];
  const found = collided(entries, [
    { version: '1', commands: ['zip', 'unzip'] },
    { version: '2', commands: ['unzip', 'more'] },
    null,
  ]);
  assert.equal(found.get('a').withheld, undefined);
  assert.equal(found.get('b').withheld, "its unzip command is zip's");
  assert.equal(found.get('c'), null);
});
