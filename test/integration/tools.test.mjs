import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { boot, toolsSettled } from './bios.mjs';
import { emptyAgent, launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';
import { fakeRelease } from './fake-npm.mjs';
import { shoot } from './shots.mjs';

const JQ = '@ai-ecoverse/wasm-jq';
const TOOLS = '/opt/slicc/tools/node_modules';
const chrome = await launch({ timeout: 120000, intercept: [] });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

const source = (file) => readFile(new URL(`../../src/packages/${file}`, import.meta.url), 'utf8');
const listed = JSON.parse(await source('tools.json'));

async function pinnedBefore(version) {
  const lock = JSON.parse(await source('package-lock.json'));
  const doc = JSON.parse(
    (await download(`https://registry.npmjs.org/${JQ}/${encodeURIComponent(version)}`)).toString()
  );
  lock.packages[''].dependencies[JQ] = version;
  lock.packages[`node_modules/${JQ}`] = {
    version,
    resolved: doc.dist.tarball,
    integrity: doc.dist.integrity,
  };
  return JSON.stringify(lock, null, 2);
}

function prepare() {
  registry.reset();
  for (const name of Object.keys(listed)) registry.names.add(name);
  for (const [path, body] of Object.entries(emptyAgent)) chrome.overrides.set(path, body);
}

async function sh(page, command) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  return page.evaluate(async (command) => {
    globalThis.toolsClient ??= await globalThis.sliccKernelClient();
    const { status, stdout, stderr } = await globalThis.toolsClient.run(['bash', '-c', command], {
      cwd: '/',
    });
    return { code: String(status), out: `${stdout ?? ''}${stderr ?? ''}`.trim() };
  }, command);
}

const rows = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .filter((item) => item.id.startsWith('tools:'))
      .map(({ id, package: name, state, version, offered, error, newer, actions }) => ({
        id,
        name,
        state,
        version,
        offered,
        error,
        newer,
        actions,
      }))
  );

const jqRow = async (page) => (await rows(page)).find((row) => row.name === JQ);

async function act(page, id, action) {
  return page.evaluate(
    ([id, action]) =>
      document
        .querySelector('slicc-app')
        .model.updates.actPackage(id, action)
        .then(
          () => 'ok',
          (error) => error.message
        ),
    [id, action]
  );
}

const versionOf = (page, path) =>
  page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part);
      const file = await (await dir.getFileHandle('package.json')).getFile();
      return JSON.parse(await file.text()).version;
    } catch {
      return null;
    }
  }, path);

test('a fresh profile gets every tool after boot, from npm, into /opt/slicc/tools and not /node_modules, and lists each one', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  prepare();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  const found = await rows(page);
  assert.deepEqual(
    found.map((row) => row.name),
    Object.keys(listed),
    'one row per tool, in tools.json’s order'
  );
  for (const row of found) {
    assert.equal(row.state, 'installed', JSON.stringify(row));
    assert.ok(row.version, row.name);
  }
  t.diagnostic(
    `tools: ${found.map((row) => `${row.name.split('/').at(-1)} ${row.version} (offered ${row.offered})`).join(', ')}`
  );
  const ran = await sh(
    page,
    'jq --version && rg --version | head -1 && curl --version | head -1 && sed --version | head -1'
  );
  assert.equal(ran.code, '0', ran.out);
  const where = await sh(
    page,
    `test -e ${TOOLS}/${JQ}/package.json && test ! -e /node_modules/${JQ} && test -e /node_modules/@ai-ecoverse/wasm-bash/package.json && echo split`
  );
  assert.equal(where.out, 'split');
  await shoot(page, 'tools-installed', { show: 'updates', target: '[data-id="tools:grep"]' });
  assert.deepEqual(page.errors, []);
});

test('an old profile keeps its base-set copy of a tool until seven has installed the tool, so it works offline, and then removes the old copy', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  prepare();
  chrome.overrides.set('/packages/package-lock.json', await pinnedBefore('1.8.2-4'));
  chrome.overrides.set('/packages/tools.json', '{}\n');
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  assert.equal(await versionOf(page, `/node_modules/${JQ}`), '1.8.2-4');

  chrome.overrides.delete('/packages/package-lock.json');
  chrome.overrides.delete('/packages/tools.json');
  registry.down = true;
  await boot(page);
  const offline = await sh(page, `jq --version && test ! -e ${TOOLS}/${JQ} && echo old-copy`);
  assert.equal(offline.code, '0', offline.out);
  assert.match(offline.out, /old-copy/);
  assert.equal((await jqRow(page)).version, '1.8.2-4');

  registry.down = false;
  assert.equal(await act(page, 'tools:jq', 'retry'), 'ok');
  await toolsSettled(page);
  const moved = await sh(
    page,
    `jq --version && test -e ${TOOLS}/${JQ}/package.json && test ! -e /node_modules/${JQ} && echo moved`
  );
  assert.equal(moved.code, '0', moved.out);
  assert.match(moved.out, /moved/);
  assert.deepEqual(page.errors, []);
});

test('seven judges every package pnpm resolved for the tools before pnpm downloads any of them: each tool’s version doc is asked for before its tarball', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  prepare();
  registry.asked.length = 0;
  await boot(page);
  const asked = [...registry.asked];
  const order = [];
  for (const name of Object.keys(listed)) {
    const version = await versionOf(page, `${TOOLS}/${name}`);
    assert.ok(version, `${name} is installed`);
    const short = name.split('/').pop();
    const judged = asked.indexOf(
      `https://registry.npmjs.org/${name}/${encodeURIComponent(version)}`
    );
    const fetched = asked.indexOf(`https://registry.npmjs.org/${name}/-/${short}-${version}.tgz`);
    order.push(`${short}@${version} doc ${judged} tarball ${fetched}`);
    if (fetched >= 0) assert.ok(judged >= 0 && judged < fetched, order.at(-1));
  }
  assert.ok(
    order.some((line) => !/tarball -1$/.test(line)),
    `pnpm downloaded the tools through the page: ${order.join(', ')}`
  );
  assert.deepEqual(page.errors, []);
});

const HOMESCOOP = 'https://github.com/ai-ecoverse/homescoop';
const at = (path) => `https://registry.npmjs.org${path}`;
const latestOf = async (name) =>
  JSON.parse((await download(at(`/${name}/latest`))).toString()).version;
const both = (name) => [at(`/${name}`), at(`/${name.replace('/', '%2F')}`)];

test('a lock entry the gate refuses keeps its tool out, even another version of a listed tool reached as a dependency: sed’s new release needs a jq with no build record, so sed isn’t installed, neither tarball is fetched, and the other tools are', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const SED = '@ai-ecoverse/wasm-sed';
  const page = await chrome.page(t);
  prepare();
  const [realJq, realSed] = await Promise.all([latestOf(JQ), latestOf(SED)]);
  const loose = await fakeRelease({
    name: JQ,
    from: realJq,
    version: '1.8.2-99',
    repository: HOMESCOOP,
  });
  loose.provenance = false;
  const needing = await fakeRelease({
    name: SED,
    from: realSed,
    version: '4.10.0-99',
    repository: HOMESCOOP,
    dependencies: { [JQ]: '^1.8.2-99' },
  });
  needing.workflow = { ref: 'refs/heads/main', path: '.github/workflows/publish.yml' };
  const tarballs = [at(`/${SED}/-/wasm-sed-4.10.0-99.tgz`), at(`/${JQ}/-/wasm-jq-1.8.2-99.tgz`)];
  const sedDoc = await needing.serve(at(`/${SED}/latest`));
  for (const url of both(SED)) registry.docs.set(url, await needing.serve(at(`/${SED}`)));
  registry.docs.set(at(`/${SED}/latest`), sedDoc);
  registry.docs.set(at(`/${SED}/4.10.0-99`), sedDoc);
  registry.docs.set(tarballs[0], await needing.serve(tarballs[0]));
  registry.docs.set(
    at(`/-/npm/v1/attestations/${SED.replace('/', '%2f')}@4.10.0-99`),
    await needing.serve(at(`/-/npm/v1/attestations/${SED}@4.10.0-99`))
  );
  const jqAll = JSON.parse(await loose.serve(at(`/${JQ}`)));
  jqAll['dist-tags'].latest = realJq;
  for (const url of both(JQ)) registry.docs.set(url, JSON.stringify(jqAll));
  registry.docs.set(at(`/${JQ}/1.8.2-99`), await loose.serve(at(`/${JQ}/latest`)));
  registry.docs.set(tarballs[1], await loose.serve(tarballs[1]));
  registry.asked.length = 0;
  await boot(page);
  const all = await rows(page);
  const sed = all.find((row) => row.name === SED);
  assert.equal(sed.state, 'failed', JSON.stringify(sed));
  assert.match(sed.error ?? '', /wasm-jq 1\.8\.2-99/, JSON.stringify(sed));
  assert.equal(await versionOf(page, `${TOOLS}/${SED}`), null, 'sed stays out');
  assert.equal(await versionOf(page, `${TOOLS}/${JQ}`), realJq, 'jq is the one seven chose');
  assert.deepEqual(
    registry.asked.filter((url) => tarballs.includes(url)),
    [],
    'neither the refused jq nor the sed that needs it is downloaded'
  );
  const others = all.filter((row) => row.name !== SED && listed[row.name]?.first);
  assert.ok(
    others.every((row) => row.state === 'installed'),
    `the other first tools install: ${JSON.stringify(others)}`
  );
  for (const name of ['@ai-ecoverse/wasm-xz', '@ai-ecoverse/wasm-tree']) {
    const row = all.find((one) => one.name === name);
    assert.equal(
      row?.state,
      'installed',
      `${name}, whose peers name sed, still installs: ${JSON.stringify(row)}`
    );
    assert.equal(await versionOf(page, `${TOOLS}/${name}`), await latestOf(name), name);
  }
  assert.deepEqual(page.errors, []);
});

test('a refused lock entry of a tool outside the batch blocks the install: with the installed tar withdrawn, gzip’s update isn’t downloaded and gzip keeps its version', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const GZIP = '@ai-ecoverse/wasm-gzip';
  const TAR = '@ai-ecoverse/wasm-tar';
  const page = await chrome.page(t);
  prepare();
  const all = JSON.parse((await download(at(`/${GZIP}`))).toString());
  const latest = all['dist-tags'].latest;
  const versions = Object.keys(all.versions);
  const older = versions[versions.indexOf(latest) - 1];
  assert.ok(older, `gzip has a release before ${latest}`);
  registry.latest.set(GZIP, older);
  await boot(page);
  assert.equal(await versionOf(page, `${TOOLS}/${GZIP}`), older);
  const tar = await versionOf(page, `${TOOLS}/${TAR}`);
  assert.ok(tar, 'tar is installed');
  registry.latest.delete(GZIP);
  registry.docs.set(
    'https://raw.githubusercontent.com/ai-ecoverse/homescoop/main/certification-exceptions.json',
    JSON.stringify({
      schema: 1,
      entries: [
        { package: TAR, versions: [tar], verdict: 'fail', issue: 'https://example.test/1' },
      ],
    })
  );
  registry.asked.length = 0;
  const result = await act(page, 'tools:gzip', 'retry');
  const gzip = (await rows(page)).find((row) => row.name === GZIP);
  assert.notEqual(result, 'ok', JSON.stringify(gzip));
  assert.equal(gzip.state, 'failed', JSON.stringify(gzip));
  assert.equal(await versionOf(page, `${TOOLS}/${GZIP}`), older, 'gzip keeps its version');
  const log = await page.evaluate(
    () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((row) => row.id === 'tools:gzip')?.log ?? ''
  );
  assert.match(log, new RegExp(`wasm-tar@${tar.replace(/\./g, '\\.')} fails the checks`), log);
  assert.deepEqual(
    registry.asked.filter((url) => url === at(`/${GZIP}/-/wasm-gzip-${latest}.tgz`)),
    [],
    'gzip’s update is never downloaded'
  );
  assert.deepEqual(page.errors, []);
});

test('a tools round whose pnpm goes quiet gives up after its idle limit and releases the pnpm store, so the tools settle and the agent install still finishes', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  prepare();
  registry.hold = /\/@ai-ecoverse\/wasm-jq\/-\/wasm-jq-[^/]+\.tgz$/;
  await page.goto('/');
  await toolsSettled(page, 12 * 60 * 1000);
  const jq = await jqRow(page);
  assert.equal(jq.state, 'failed', JSON.stringify(jq));
  const log = await page.evaluate(
    () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((row) => row.id === 'tools:jq')?.log ?? ''
  );
  assert.match(log, /pnpm wrote nothing for \d+ s/, log);
  const later = (await rows(page)).filter((row) => !listed[row.name]?.first);
  assert.ok(
    later.every((row) => row.state === 'installed'),
    `the second round still installs: ${JSON.stringify(later)}`
  );
  await page.within(10 * 60 * 1000, () => {
    const agent = document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent');
    window.sliccAgentSeen = agent?.state ?? 'absent';
    return !!agent && !/queued|starting|checking|downloading|linking|installing/.test(agent.state);
  });
  const held = await page.evaluate(async () =>
    ((await navigator.locks.query()).held ?? []).map((lock) => lock.name)
  );
  assert.ok(!held.includes('slicc-pnpm-store'), `the pnpm store is free: ${held.join(', ')}`);
  registry.hold = null;
  assert.equal(await act(page, 'tools:jq', 'retry'), 'ok', 'the failed round runs again');
  assert.equal((await jqRow(page)).state, 'installed');
  assert.ok(await versionOf(page, `${TOOLS}/${JQ}`), 'jq is installed once npm answers');
  assert.deepEqual(page.errors, []);
});

test('while the first tools round runs, a tool’s command says seven is still installing it; once the round ends, an installed tool runs and one that didn’t install is plainly not found', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  prepare();
  registry.hold = /\/@ai-ecoverse\/wasm-jq\/-\/wasm-jq-[^/]+\.tgz$/;
  t.after(() => {
    registry.hold = null;
  });
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto('/');
  const pending = await page.within(5 * 60 * 1000, async () => {
    if (typeof globalThis.sliccKernelClient !== 'function') return false;
    globalThis.pendingClient ??= await globalThis.sliccKernelClient();
    const { status, stdout, stderr } = await globalThis.pendingClient.run(
      ['bash', '-c', 'jq --version; echo "rc=$?"; command -v less'],
      { cwd: '/' }
    );
    const out = `${stdout}${stderr}`;
    window.pendingSeen = out;
    return status === 0 && /still installing/.test(out) && out;
  });
  assert.match(
    pending,
    /^jq: seven is still installing it; Install \/ Update shows its progress$/m,
    pending
  );
  assert.match(pending, /^rc=127$/m, pending);
  assert.match(pending, /^\/usr\/bin\/less$/m, 'every tool’s command has its placeholder');

  await toolsSettled(page, 15 * 60 * 1000);
  assert.equal((await jqRow(page)).state, 'failed');
  const after = await sh(
    page,
    'jq --version; echo "rc=$?"; command -v jq || echo "no-jq"; less --version | head -1; test -e /opt/slicc/pending || echo "no-pending"'
  );
  assert.match(after.out, /jq: command not found/, after.out);
  assert.doesNotMatch(after.out, /still installing/, after.out);
  assert.match(after.out, /^rc=127$/m, after.out);
  assert.match(after.out, /^no-jq$/m, after.out);
  assert.match(after.out, /^less \d/m, 'a tool that installed runs');
  assert.match(after.out, /^no-pending$/m, after.out);
  assert.deepEqual(page.errors, []);
});

test('seven never takes a tool back to an older npm latest, and a newer release that fails the gate leaves the installed one in place', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  prepare();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  const first = await versionOf(page, `${TOOLS}/${JQ}`);
  assert.match(first ?? '', /^1\.8\.2-\d+$/);

  registry.latest.set(JQ, '1.8.2-3');
  assert.equal(await act(page, 'tools:jq', 'retry'), 'ok');
  assert.equal(await versionOf(page, `${TOOLS}/${JQ}`), first, 'no downgrade');
  assert.equal((await jqRow(page)).version, first);

  registry.latest.delete(JQ);
  const forged = await fakeRelease({
    name: JQ,
    from: first,
    version: '1.8.2-99',
    repository: 'https://github.com/ai-ecoverse/homescoop',
  });
  const at = (path) => `https://registry.npmjs.org${path}`;
  const latest = await forged.serve(at(`/${JQ}/latest`));
  registry.docs.set(at(`/${JQ}`), await forged.serve(at(`/${JQ}`)));
  registry.docs.set(at(`/${JQ}/latest`), latest);
  registry.docs.set(at(`/${JQ}/1.8.2-99`), latest);
  registry.docs.set(
    at(`/${JQ}/-/wasm-jq-1.8.2-99.tgz`),
    await forged.serve(at(`/${JQ}/-/wasm-jq-1.8.2-99.tgz`))
  );
  registry.docs.set(
    at(`/-/npm/v1/attestations/${JQ.replace('/', '%2f')}@1.8.2-99`),
    await forged.serve(at(`/-/npm/v1/attestations/${JQ}@1.8.2-99`))
  );
  assert.equal(await act(page, 'tools:jq', 'retry'), 'ok');
  const row = await jqRow(page);
  assert.equal(row.version, first, JSON.stringify(row));
  assert.equal(row.newer?.version, '1.8.2-99', JSON.stringify(row));
  assert.equal(row.newer.reason, "it didn't come from SLICC's own build");
  assert.equal(await versionOf(page, `${TOOLS}/${JQ}`), first, 'the refused release stays out');
  await shoot(page, 'tools-newer', { show: 'updates', target: '[data-id="tools:jq"]' });
  assert.deepEqual(page.errors, []);
});
