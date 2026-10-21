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
  await shoot(page, 'tools-installed', { show: 'updates', target: '[data-id="tools:tls-engine"]' });
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

test('seven never takes a tool back to an older npm latest, and a newer release that fails the gate leaves the installed one in place', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  prepare();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  assert.equal(await versionOf(page, `${TOOLS}/${JQ}`), '1.8.2-4');

  registry.latest.set(JQ, '1.8.2-3');
  assert.equal(await act(page, 'tools:jq', 'retry'), 'ok');
  assert.equal(await versionOf(page, `${TOOLS}/${JQ}`), '1.8.2-4', 'no downgrade');
  assert.equal((await jqRow(page)).version, '1.8.2-4');

  registry.latest.delete(JQ);
  const forged = await fakeRelease({
    name: JQ,
    from: '1.8.2-4',
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
  assert.equal(row.version, '1.8.2-4', JSON.stringify(row));
  assert.equal(row.newer?.version, '1.8.2-99', JSON.stringify(row));
  assert.equal(row.newer.reason, "it didn't come from SLICC's own build");
  assert.equal(await versionOf(page, `${TOOLS}/${JQ}`), '1.8.2-4', 'the refused release stays out');
  await shoot(page, 'tools-newer', { show: 'updates', target: '[data-id="tools:jq"]' });
  assert.deepEqual(page.errors, []);
});
