import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const PINNED = ['src/packages/package.json', 'src/packages/agent/package.json'];
const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const config = JSON.parse(await read('renovate.json'));
const HOMESCOOP = /^@ai-ecoverse\/(wasi|wasix|wasm|py)-/;
const PYTHON = '@ai-ecoverse/wasix-python';
const DATA_TOOLS = 'src/packages/optional/projects/pydata/package.json';
const OWN = [
  '@ai-ecoverse/slicc-kernel',
  '@ai-ecoverse/slicc-agent',
  '@ai-ecoverse/slicc-spectrum',
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

test('renovate.json parses, extends the shared preset and names the two pinned package files; the optional catalog pins nothing', async () => {
  assert.deepEqual(config.extends, ['github>ai-ecoverse/slicc-shared-web']);
  assert.ok(!JSON.stringify(config).includes('src/packages/optional/package.json'));
  await assert.rejects(read('src/packages/optional/package.json'), { code: 'ENOENT' });
  await assert.rejects(read('src/packages/optional/package-lock.json'), { code: 'ENOENT' });
  assert.equal(config.ignoreDeps, undefined, 'holds are packageRules with a description');
  for (const rule of config.packageRules)
    assert.ok(rule.description?.length > 20, JSON.stringify(rule));
});

test('every @ai-ecoverse pin in the base set and /opt/agent but slicc-agent bumps by itself and automerges; slicc-agent waits for its coordinated pins', async () => {
  const found = await pins();
  assert.ok(found.length >= 9, `${found.length} pins`);
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

test('homescoop packages but Python are one daily PR; the kernel, slicc-agent and spectrum each get their own', async () => {
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

test('every py-* of the Python data tools is one PR, opened from the dependency dashboard and never automerged, so 3.14 and 3.15 builds never mix; the catalog’s Python follows its range', async () => {
  const catalog = JSON.parse(await read('src/packages/optional/catalog.json'));
  assert.equal(catalog[PYTHON].range, '3.15.0');
  assert.equal(catalog[PYTHON].abi, 'cp315');
  const tools = Object.keys(JSON.parse(await read(DATA_TOOLS)).dependencies);
  assert.ok(
    tools.length >= 4 && tools.every((name) => name.startsWith('@ai-ecoverse/py-')),
    tools.join()
  );
  for (const [name, file] of tools.map((name) => [name, DATA_TOOLS])) {
    const rule = effective(name, file);
    assert.equal(rule.groupName, 'python and py-*', `${name} in ${file}`);
    assert.equal(rule.groupSlug, 'python', name);
    assert.equal(rule.automerge, false, name);
    assert.equal(rule.dependencyDashboardApproval, true, name);
    assert.deepEqual(rule.schedule, ['at any time'], name);
  }
  assert.equal(effective('@ai-ecoverse/wasm-bash', PINNED[0]).groupName, 'homescoop packages');
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

test('the slicc-shared-web npm package and the pipeline ref in ci.yml move together in one PR, so the harness and the pipeline stay one release', () => {
  const rule = config.packageRules.find((rule) => rule.groupSlug === 'slicc-shared-web');
  assert.deepEqual(rule?.matchPackageNames, [
    '@ai-ecoverse/slicc-shared-web',
    'ai-ecoverse/slicc-shared-web',
  ]);
  assert.equal(rule.groupName, 'slicc-shared-web');
  assert.doesNotMatch(JSON.stringify(config), /cert-review|release-state|ci \/ test/);
});

test('a bump of a jsDelivr pin in seven’s sources is a fix: commit, so it releases and reaches seven', async () => {
  const source = await read('src/installer.js');
  assert.match(source, /https:\/\/cdn\.jsdelivr\.net\/npm\/modern-tar@\d/);
  const rules = config.packageRules.filter(
    (rule) =>
      rule.matchManagers?.includes('custom.regex') &&
      rule.matchFileNames?.some((pattern) => glob(pattern).test('src/installer.js'))
  );
  assert.deepEqual(
    rules.map((rule) => rule.semanticCommitType),
    ['fix']
  );
  assert.equal(rules[0].matchPackageNames, undefined);
});
