import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const PINNED = [
  'src/packages/package.json',
  'src/packages/optional/package.json',
  'src/packages/agent/package.json',
];
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

test('known breaks are holds with a reason and an issue: wasi-pnpm without 12.9.1-11 and -12; wasm-bash moves freely now that kernel 1.135.2 has slicc-kernel#1146', () => {
  const holds = config.packageRules.filter(
    (rule) => 'allowedVersions' in rule || rule.enabled === false || 'ignoreVersions' in rule
  );
  for (const rule of holds)
    assert.match(
      rule.description,
      /\b[\w-]+\/[\w-]+#\d+/,
      `${rule.matchPackageNames} names its issue`
    );
  assert.equal(effective('@ai-ecoverse/wasm-bash', PINNED[0]).allowedVersions, undefined);
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
