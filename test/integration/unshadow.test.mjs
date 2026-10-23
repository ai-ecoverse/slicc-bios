import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, ready, run, screen, shows } from './bios.mjs';
import { offered } from './catalog.mjs';
import { launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';

const MCPCAT = '@ai-ecoverse/mcpcat';
const GLUE = '@ai-ecoverse/hot-glue';
const pins = { [MCPCAT]: '0.16.3', [GLUE]: '0.3.0' };
const BIN = '/usr/local/share/pnpm/bin';
const SHIPPED = await offered(MCPCAT);

const chrome = await launch({ timeout: 120000, intercept: [] });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

function offer() {
  const release = '.github/workflows/release.yml';
  const catalog = {
    [MCPCAT]: {
      id: 'mcpcat',
      label: 'mcpcat',
      source: { repo: 'ai-ecoverse/mcpcat', workflow: release },
    },
    [GLUE]: {
      id: 'hot-glue',
      label: 'hot-glue',
      notes: ['A package with only a Node bin.'],
      source: { repo: 'ai-ecoverse/hot-glue', workflow: release },
    },
  };
  registry.reset();
  for (const [name, version] of Object.entries(pins)) registry.latest.set(name, version);
  chrome.overrides.set('/packages/optional/catalog.json', JSON.stringify(catalog));
}

async function sh(page, command) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  return page.evaluate(async (command) => {
    globalThis.unshadowClient ??= await globalThis.sliccKernelClient();
    return globalThis.unshadowClient.run(['bash', '-c', command], { cwd: '/' }).then(
      ({ status, stdout, stderr }) => ({
        code: String(status),
        out: `${stdout ?? ''}${stderr ?? ''}`.trim(),
      }),
      (error) => ({ code: 'error', out: error.message })
    );
  }, command);
}

const rows = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .map(({ id, state, version, offered, error }) => ({ id, state, version, offered, error }))
  );

async function install(page, id) {
  const started = Date.now();
  await page
    .within(
      120000,
      (id) =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .some((item) => item.id === id && item.state === 'available'),
      id
    )
    .catch(async (error) => {
      throw new Error(`${error.message}\nrows: ${JSON.stringify(await rows(page))}`);
    });
  console.log(`unshadow: the ${id} row was available after ${Date.now() - started} ms`);
  const installing = Date.now();
  assert.equal(await actPackage(page, id, 'install'), 'ok', JSON.stringify(await rows(page)));
  console.log(`unshadow: ${id} installed in ${Date.now() - installing} ms`);
}

test('a catalog package’s kernel command wins over the same package’s Node bin, and a package with only a bin keeps it', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  const booting = Date.now();
  await boot(page);
  console.log(`unshadow: booted in ${Date.now() - booting} ms`);

  await install(page, 'mcpcat');
  const found = await sh(page, 'command -v mcpcat');
  assert.deepEqual(found, { code: '0', out: '/usr/bin/mcpcat' });
  const version = await sh(page, 'mcpcat --version');
  assert.equal(version.code, '0', version.out);
  assert.match(version.out, /0\.16\.3/);
  const gone = await sh(page, `test -e ${BIN}/mcpcat || test -L ${BIN}/mcpcat; echo $?`);
  assert.equal(gone.out, '1');

  await install(page, 'hot-glue');
  const kept = await sh(page, `test -e ${BIN}/hotglue || test -L ${BIN}/hotglue; echo $?`);
  assert.equal(kept.out, '0');
  assert.deepEqual(await sh(page, 'command -v hotglue'), { code: '0', out: `${BIN}/hotglue` });

  const listed = await sh(page, `ls ${BIN}`);
  assert.doesNotMatch(listed.out, /^mcpcat$/m);
  assert.match(listed.out, /^hotglue$/m);
  assert.deepEqual(page.errors, []);
});

test('bios#715: a shell pnpm add -g, as root and as cone, leaves the package’s kernel command first on PATH, a package with only a bin keeps its link, and a Node link left from before goes at the next boot', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page);
  const pnpm = `pnpm add -g --config.minimum-release-age=0 ${MCPCAT}@${SHIPPED} ${GLUE}@${pins[GLUE]}`;
  const node = 'head -c 19 "$PNPM_HOME/bin/mcpcat" 2>/dev/null | grep -q /usr/bin/env';
  const settle = `n=0; while ${node} && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done; ${node} && echo still-node || echo settled-after-$n`;
  const look =
    'echo "found $(command -v mcpcat) $(command -v hotglue)"; echo "first $(head -n 1 "$(command -v mcpcat)" | cut -c1-19)"; mcpcat --version';
  const check = (text, bin) => {
    t.diagnostic(`${bin}: ${text.match(/settled-after-\d+|still-node/)?.[0]}`);
    assert.match(text, /added-0/, text);
    assert.match(text, /\nsettled-after-\d+\n/, text);
    assert.match(text, new RegExp(`found \\S+/mcpcat ${bin}/hotglue`), text);
    assert.doesNotMatch(text, /first #!\/usr\/bin\/env node/, text);
    assert.match(text, new RegExp(`\\n${SHIPPED.replaceAll('.', '\\.')}\\s`), text);
    assert.doesNotMatch(text, /bad interpreter/, text);
  };
  await run(
    page,
    `clear; ${pnpm} > /tmp/add.log 2>&1; echo added-$?; tail -c 300 /tmp/add.log; ${settle}; ${look}; echo root-$((40 + 2))`
  );
  await shows(page, 'root-42', 10 * 60 * 1000).catch(async (error) => {
    throw new Error(`${error.message}\n${await screen(page)}`);
  });
  const log = await sh(page, 'cat /tmp/add.log');
  check((await screen(page)).replace(/ {2,}/g, '\n') + log.out, BIN);

  const cone = '/home/cone/.local/share/pnpm/bin';
  const asCone = `PATH=$PNPM_HOME/bin:$PATH; ${pnpm} > /tmp/cone.log 2>&1; echo added-$?; ${settle}; ${look}`;
  await run(
    page,
    `clear; sudo -u cone bash -c '${asCone.replaceAll("'", "'\\''")}'; echo cone-$((40 + 2))`
  );
  await shows(page, 'cone-42', 10 * 60 * 1000);
  const coneLog = await sh(page, 'cat /tmp/cone.log');
  check((await screen(page)).replace(/ {2,}/g, '\n') + coneLog.out, cone);

  await page.evaluate(async (owner) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['usr', 'local', 'share', 'pnpm', 'bin'])
      dir = await dir.getDirectoryHandle(part);
    const writable = await (await dir.getFileHandle('mcpcat', { create: true })).createWritable();
    await writable.write(`#!/usr/bin/env node\nimport '${owner}dist/host/mcpcat.mjs';\n`);
    await writable.close();
  }, '/usr/local/share/pnpm/global/v11/x/node_modules/@ai-ecoverse/mcpcat/');
  assert.equal((await sh(page, `head -c 19 ${BIN}/mcpcat`)).out, '#!/usr/bin/env node');
  await page.reload();
  await ready(page);
  const left = await sh(
    page,
    `n=0; while [ -e ${BIN}/mcpcat ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done; [ -e ${BIN}/mcpcat ] && echo left || echo gone; command -v mcpcat`
  );
  assert.deepEqual(left, { code: '0', out: 'gone\n/usr/bin/mcpcat' });
  assert.deepEqual(page.errors, []);
});
