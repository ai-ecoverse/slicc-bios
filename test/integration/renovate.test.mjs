import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../../scripts/cert/apply.mjs';
import { changed, gate, PINNED } from '../../scripts/ci/certified.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const config = JSON.parse(await read('renovate.json'));
const HOMESCOOP = /^@ai-ecoverse\/(wasi|wasix|wasm|py)-/;
const PYTHON = '@ai-ecoverse/wasix-python';
const DATA_TOOLS = 'src/packages/optional/projects/pydata/package.json';
const OWN = [
  '@ai-ecoverse/slicc-kernel',
  '@ai-ecoverse/slicc-cdp',
  '@ai-ecoverse/slicc-agent',
  '@ai-ecoverse/slicc-spectrum',
  '@ai-ecoverse/slicc-jsh',
];

const glob = (pattern) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\0')
      .replace(/\*/g, '[^/]*')
      .replace(/\0/g, '.*')}$`
  );

function effective(name, file) {
  const result = {};
  for (const rule of config.packageRules) {
    if (rule.matchFileNames && !rule.matchFileNames.includes(file)) continue;
    if (rule.matchPackageNames && !rule.matchPackageNames.some((p) => glob(p).test(name))) continue;
    const { description, matchFileNames, matchPackageNames, ...rest } = rule;
    Object.assign(result, rest);
  }
  return result;
}

async function pins() {
  const found = [];
  for (const file of PINNED)
    for (const name of Object.keys(JSON.parse(await read(file)).dependencies ?? {}))
      if (name.startsWith('@ai-ecoverse/')) found.push([name, file]);
  return found;
}

test('renovate.json parses, extends the shared preset and names the three pinned package files', () => {
  assert.deepEqual(config.extends, ['github>ai-ecoverse/slicc-shared-web']);
  assert.deepEqual(PINNED, [
    'src/packages/package.json',
    'src/packages/optional/package.json',
    'src/packages/agent/package.json',
  ]);
  assert.equal(config.ignoreDeps, undefined, 'holds are packageRules with a description');
  for (const rule of config.packageRules)
    assert.ok(rule.description?.length > 20, JSON.stringify(rule));
});

test('every @ai-ecoverse pin in the base set, the optional catalog and /opt/agent but Python and slicc-agent bumps by itself and automerges; slicc-agent waits for its coordinated pins', async () => {
  const found = await pins();
  assert.ok(found.length > 40, `${found.length} pins`);
  for (const file of PINNED)
    assert.ok(
      found.some(([, at]) => at === file),
      file
    );
  for (const [name, file] of found.filter(([name]) => name !== PYTHON)) {
    const rule = effective(name, file);
    assert.equal(rule.automerge, name !== '@ai-ecoverse/slicc-agent', `${name} in ${file}`);
    assert.equal(rule.dependencyDashboardApproval, false, `${name} in ${file}`);
    assert.notEqual(rule.enabled, false, `${name} in ${file}`);
  }
});

test('homescoop packages but Python are one daily PR; the kernel, slicc-cdp, slicc-agent, spectrum and slicc-jsh each get their own', async () => {
  const found = await pins();
  for (const [name, file] of found.filter(([name]) => HOMESCOOP.test(name) && name !== PYTHON)) {
    const rule = effective(name, file);
    assert.equal(rule.groupName, 'homescoop packages', name);
    assert.deepEqual(rule.schedule, ['* 0-5 * * *'], name);
  }
  for (const name of OWN) {
    const at = found.filter(([pinned]) => pinned === name);
    assert.ok(at.length, `${name} is pinned`);
    for (const [, file] of at) {
      const { groupName } = effective(name, file);
      assert.ok(
        groupName === undefined || groupName === name.split('/')[1],
        `${name}: ${groupName}`
      );
    }
  }
  assert.ok(found.some(([name]) => name === '@ai-ecoverse/wasi-pnpm'));
  assert.equal(effective('@ai-ecoverse/wasi-pnpm', PINNED[0]).groupName, 'homescoop packages');
});

test('the catalog’s Python and every py-* of the Python data tools are one PR, opened from the dependency dashboard and never automerged, so 3.14 and 3.15 builds never mix', async () => {
  const found = await pins();
  assert.ok(found.some(([name, file]) => name === PYTHON && file === PINNED[1]));
  const tools = Object.keys(JSON.parse(await read(DATA_TOOLS)).dependencies);
  assert.ok(
    tools.length >= 4 && tools.every((name) => name.startsWith('@ai-ecoverse/py-')),
    tools.join()
  );
  for (const [name, file] of [[PYTHON, PINNED[1]], ...tools.map((name) => [name, DATA_TOOLS])]) {
    const rule = effective(name, file);
    assert.equal(rule.groupName, 'python and py-*', `${name} in ${file}`);
    assert.equal(rule.groupSlug, 'python', name);
    assert.equal(rule.automerge, false, name);
    assert.equal(rule.dependencyDashboardApproval, true, name);
    assert.deepEqual(rule.schedule, ['at any time'], name);
  }
  assert.equal(effective('@ai-ecoverse/wasix-perl', PINNED[1]).groupName, 'homescoop packages');
});

test('known breaks are holds with a reason and an issue: wasm-bash below 5.3.0-20, wasi-pnpm without 12.9.1-11 and -12', () => {
  const holds = config.packageRules.filter(
    (rule) => 'allowedVersions' in rule || rule.enabled === false || 'ignoreVersions' in rule
  );
  for (const rule of holds)
    assert.match(
      rule.description,
      /\b[\w-]+\/[\w-]+#\d+/,
      `${rule.matchPackageNames} names its issue`
    );
  const bash = effective('@ai-ecoverse/wasm-bash', PINNED[0]);
  assert.equal(bash.allowedVersions, '<5.3.0-20');
  assert.match(
    holds.find((rule) => rule.allowedVersions === '<5.3.0-20').description,
    /slicc-kernel#1146/
  );
  const pnpm = effective('@ai-ecoverse/wasi-pnpm', PINNED[0]).allowedVersions;
  const [, pattern] = pnpm.match(/^!\/(.+)\/$/);
  const refused = (version) => new RegExp(pattern).test(version);
  assert.deepEqual(
    ['12.9.1-10', '12.9.1-11', '12.9.1-12', '12.9.1-13', '12.9.1-111'].map(refused),
    [false, true, true, false, false]
  );
});

const NAME = '@ai-ecoverse/wasm-bzip2';
const SHA = 'eff7f59d50f541f9a1abd352893255de875859b4b58928148799af8ff7c3150d';
const INTEGRITY =
  'sha512-FzE8FE3sMzOQLwm3hV1SFW717mhSjjrchGOgFuZW8JCZ57oPs6gJ/915POb5DHsjv3luXKnd2uycKdlOsdZoEQ==';
const verdict = (name, version, body = '') =>
  [
    `**Cert review: ${name}@${version}** (from 1.0.0)`,
    '| Check | Result |',
    `certified ${name}@${version} sha256=${SHA} (ci: x)`,
    `certs.json: "${name}@${version}": { "integrity": "${INTEGRITY}", "sha256": "${SHA}" }`,
    body,
  ].join('\n');
const posted = (text, check = 'ok') => ({
  user: 'github-actions[bot]',
  body: `${text}\n\n<sub>sha check ${check}: checked · [run](x)</sub>\n`,
});

test('the gate finds only the pins a PR changes, and passes them only on their latest certified, sha-checked review by cert review', () => {
  const base = { [PINNED[0]]: { dependencies: { [NAME]: '1.0.8-1', other: '1' } } };
  const head = {
    [PINNED[0]]: { dependencies: { [NAME]: '1.0.8-2', other: '2' } },
    [PINNED[2]]: { dependencies: { '@ai-ecoverse/slicc-agent': '7.0.0' } },
  };
  const pins = changed(base, head);
  assert.deepEqual(pins, ['@ai-ecoverse/slicc-agent@7.0.0', `${NAME}@1.0.8-2`]);
  assert.equal(gate([], []).ok, true);
  assert.match(gate([], []).line, /^cert-gate: PASS/);
  const both = [
    posted(verdict(NAME, '1.0.8-2')),
    posted(verdict('@ai-ecoverse/slicc-agent', '7.0.0')),
  ];
  assert.deepEqual(gate(pins, both), {
    ok: true,
    line: `cert-gate: CERTIFIED ${pins.join(', ')}`,
  });
  assert.deepEqual(gate(pins, both.slice(0, 1)), {
    ok: false,
    line: 'cert-gate: FAIL @ai-ecoverse/slicc-agent@7.0.0 has no cert review (label the PR cert-review)',
  });
  const spoofed = both.map((comment) => ({ ...comment, user: 'someone' }));
  assert.equal(gate(pins, spoofed).ok, false);
  const mismatch = [posted(verdict(NAME, '1.0.8-2'), '**mismatch**'), both[1]];
  assert.match(
    gate(pins, mismatch).line,
    /bzip2@1\.0\.8-2 is not certified by its latest cert review/
  );
  const failedLater = [
    ...both,
    posted(
      `**Cert review: ${NAME}@1.0.8-2** (from 1.0.8-1)\ncert-ci: FAIL ${NAME}@1.0.8-2: grep exits 70`
    ),
  ];
  assert.equal(gate(pins, failedLater).ok, false);
});

test('outside Renovate the gate holds every PR to the gated pins it changes, the Tailscale and grammars projects included', async () => {
  const { GATED } = await import('../../scripts/cert/apply.mjs');
  const { GATE_FILES } = await import('../../scripts/ci/certified.mjs');
  assert.deepEqual(GATE_FILES, [
    ...PINNED,
    'src/packages/tailscale/package.json',
    'src/packages/grammars/package.json',
  ]);
  const base = {
    [PINNED[0]]: {
      dependencies: {
        '@ai-ecoverse/wasi-pnpm': '12.9.1-10',
        '@ai-ecoverse/slicc-spectrum': '1.89.2',
      },
    },
    [GATE_FILES[3]]: { dependencies: { '@ai-ecoverse/wasm-tailscale': '1.104.1-9' } },
  };
  const head = {
    [PINNED[0]]: {
      dependencies: {
        '@ai-ecoverse/wasi-pnpm': '12.9.1-13',
        '@ai-ecoverse/slicc-spectrum': '1.90.0',
      },
    },
    [GATE_FILES[3]]: { dependencies: { '@ai-ecoverse/wasm-tailscale': '1.104.1-10' } },
  };
  const gated = changed(base, head, (name) => GATED.test(name));
  assert.deepEqual(gated, [
    '@ai-ecoverse/wasi-pnpm@12.9.1-13',
    '@ai-ecoverse/wasm-tailscale@1.104.1-10',
  ]);
  assert.deepEqual(gate(gated, []), {
    ok: false,
    line: 'cert-gate: FAIL @ai-ecoverse/wasi-pnpm@12.9.1-13 has no cert review (label the PR cert-review), @ai-ecoverse/wasm-tailscale@1.104.1-10 has no cert review (label the PR cert-review)',
  });
  assert.deepEqual(
    gate(
      changed(base, base, (name) => GATED.test(name)),
      [],
      'no gated pin changes'
    ),
    {
      ok: true,
      line: 'cert-gate: PASS no gated pin changes',
    }
  );
  const spectrumOnly = {
    [PINNED[0]]: {
      dependencies: { ...base[PINNED[0]].dependencies, '@ai-ecoverse/slicc-spectrum': '1.90.0' },
    },
  };
  assert.deepEqual(
    changed(base, spectrumOnly, (name) => GATED.test(name)),
    []
  );
  const { FORK } = await import('../../scripts/ci/certified.mjs');
  assert.match(
    gate(gated.slice(0, 1), [], 'no gated pin changes', FORK).line,
    /has no cert review \(cert review never runs fork code: push the change to a branch of this repository/
  );
  const cert = await read('.github/workflows/cert-review.yml');
  assert.match(
    cert,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    'the label path stays same-repo only'
  );
  const ci = await read('scripts/ci/certified.mjs');
  assert.doesNotMatch(ci, /is not a Renovate PR/, 'every PR is gated, not only Renovate’s');
});

test('the queue adds a certified certs.json line only for a gated package the PR locks with that integrity, after the sha check', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'renovate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packages = join(dir, 'src/packages');
  await mkdir(join(packages, 'optional'), { recursive: true });
  const lock = (entries) =>
    JSON.stringify({
      packages: Object.fromEntries([
        ['', {}],
        ...entries.map(([name, version, integrity]) => [
          `node_modules/${name}`,
          { version, integrity },
        ]),
      ]),
    });
  await writeFile(join(packages, 'package-lock.json'), lock([[NAME, '1.0.8-2', INTEGRITY]]));
  await writeFile(
    join(packages, 'optional/package-lock.json'),
    lock([['@ai-ecoverse/wasm-xz', '9.9.9-1', 'sha512-other']])
  );
  const certs = { '@ai-ecoverse/wasm-gzip@1.15.0-2': { integrity: 'sha512-x', sha256: 'y' } };
  await writeFile(join(packages, 'certs.json'), `${JSON.stringify(certs, null, 2)}\n`);
  const file = join(dir, 'comment.md');
  const lookup = async () => ({ sha256: SHA, integrity: INTEGRITY, published: INTEGRITY });
  await writeFile(
    file,
    `${verdict(NAME, '1.0.8-2')}\n${verdict('@ai-ecoverse/wasm-xz', '9.9.9-1')}\n${verdict('@ai-ecoverse/slicc-agent', '7.0.0')}`
  );
  assert.deepEqual(await apply({ verdict: file, packages, lookup }), {
    ok: true,
    line: `cert-apply: ADDED ${NAME}@1.0.8-2`,
    added: [`${NAME}@1.0.8-2`],
  });
  assert.deepEqual(JSON.parse(await readFile(join(packages, 'certs.json'), 'utf8')), {
    ...certs,
    [`${NAME}@1.0.8-2`]: { integrity: INTEGRITY, sha256: SHA },
  });
  assert.equal(
    (await apply({ verdict: file, packages, lookup })).line,
    'cert-apply: NOTHING to add'
  );
  const wrong = async () => ({
    sha256: 'a'.repeat(64),
    integrity: INTEGRITY,
    published: INTEGRITY,
  });
  assert.match((await apply({ verdict: file, packages, lookup: wrong })).line, /^cert-apply: FAIL/);
  await writeFile(file, '');
  assert.match(
    (await apply({ verdict: file, packages, lookup })).line,
    /^cert-apply: FAIL .*no verdict/
  );
});

test('ci / test runs the gate on every run, CI can be dispatched for a PR, and cert review queues only after a certified verdict on a Renovate PR', async () => {
  const ci = await read('.github/workflows/ci.yml');
  assert.match(ci, /\n {2}workflow_dispatch:\n {4}inputs:\n {6}pr:\n/);
  const job = ci.slice(ci.indexOf('\n  ci:'));
  assert.match(job, /\n {6}pull-requests: read\n/);
  assert.match(
    job,
    /- name: A PR passes only[^\n]*\n {8}if: always\(\)\n(?: {8}.*\n)*? {8}run: node scripts\/ci\/certified\.mjs\n/
  );
  const cert = await read('.github/workflows/cert-review.yml');
  const queue = cert.slice(cert.indexOf('\n  queue:'), cert.indexOf('\n  certify:'));
  assert.match(queue, /needs: \[plan, certify\]/);
  assert.match(
    queue,
    /if: needs\.certify\.result == 'success' && needs\.plan\.outputs\.renovate == 'true' && github\.event_name == 'workflow_run'/
  );
  assert.match(
    queue,
    /node base\/scripts\/cert\/apply\.mjs evidence\/cert-review\/comment\.md pr\/src\/packages/
  );
  assert.match(queue, /git push origin "HEAD:refs\/heads\/\$BRANCH"/);
  assert.match(
    queue,
    /createWorkflowDispatch\(\{ owner, repo, workflow_id: 'ci\.yml', ref, inputs: \{ pr \} \}\)/
  );
  assert.doesNotMatch(queue, /\bgh /, 'the queue needs no gh on the runner');
  const email = queue.match(/git config user\.email '([^']+)'/)[1];
  assert.deepEqual(
    config.gitIgnoredAuthors,
    [email],
    'Renovate keeps rebasing after the queue commit'
  );
  assert.doesNotMatch(queue, /npm (ci|install|test)|npx /, 'the queue runs no code from the PR');
});
