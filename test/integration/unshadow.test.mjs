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
const SELFISH = '@fixture/selfish';
const QUIET = 10;
const PROMPT = 30000;

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

const asCone = (script) => `sudo -u cone bash -c '${script.replaceAll("'", "'\\''")}'`;

async function pidGrowth(page) {
  const seen = [];
  const end = Date.now() + 60000;
  while (Date.now() < end && !(seen.at(-1) <= QUIET)) {
    const before = Number((await sh(page, 'echo $$')).out);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    seen.push(Number((await sh(page, 'echo $$')).out) - before);
  }
  return seen;
}

const rows = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .map(({ id, state, version, offered, error }) => ({ id, state, version, offered, error }))
  );

async function install(page, id, limits) {
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
  assert.equal(
    await actPackage(page, id, 'install', limits),
    'ok',
    JSON.stringify(await rows(page))
  );
  console.log(`unshadow: ${id} installed in ${Date.now() - installing} ms`);
}

test('a catalog package’s kernel command wins over the same package’s Node bin, whose link now points at /usr/bin, and a package with only a bin keeps it', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  const booting = Date.now();
  await boot(page);
  console.log(`unshadow: booted in ${Date.now() - booting} ms`);

  await install(page, 'mcpcat');
  const found = await sh(page, `command -v mcpcat; readlink ${BIN}/mcpcat`);
  assert.deepEqual(found, { code: '0', out: `${BIN}/mcpcat\n/usr/bin/mcpcat` });
  const version = await sh(page, 'mcpcat --version');
  assert.equal(version.code, '0', version.out);
  assert.match(version.out, /0\.16\.3/);

  await install(page, 'hot-glue');
  const kept = await sh(page, `test -e ${BIN}/hotglue || test -L ${BIN}/hotglue; echo $?`);
  assert.equal(kept.out, '0');
  assert.deepEqual(await sh(page, 'command -v hotglue'), { code: '0', out: `${BIN}/hotglue` });

  const listed = await sh(page, `ls ${BIN}; readlink ${BIN}/hotglue`);
  assert.match(listed.out, /^mcpcat$/m);
  assert.match(listed.out, /^hotglue$/m);
  assert.doesNotMatch(listed.out, /^\/usr\/bin\/hotglue$/m);
  assert.deepEqual(page.errors, []);
});

test('bios#715: a shell pnpm add -g, as root and as cone, leaves the package’s kernel command first on PATH, a package with only a bin keeps its link, and a Node link left from before is replaced at the next boot', {
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

  assert.equal((await sh(page, `rm -f ${BIN}/mcpcat; echo $?`)).out, '0');
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
    `n=0; until [ "$(readlink ${BIN}/mcpcat)" = /usr/bin/mcpcat ] || [ $n -ge 100 ]; do sleep 0.1; n=$((n + 1)); done; readlink ${BIN}/mcpcat || echo left`
  );
  assert.deepEqual(left, { code: '0', out: '/usr/bin/mcpcat' });
  assert.deepEqual(page.errors, []);
});

test('bios#823: pnpm add -g mcpcat && mcpcat in one command runs the kernel command at once and through the hashed path, remove -g leaves no link, and an admin’s link stays, as root and cone', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page);
  const at = `${MCPCAT}@${SHIPPED}`;
  const steps = [
    `pnpm add -g --config.minimum-release-age=0 ${at} > /tmp/add-$(id -u).log 2>&1 && mcpcat --version`,
    'echo "hashed $(hash -t mcpcat)"',
    'ln -sf /usr/bin/bash "$PNPM_HOME/bin/bash"',
    'n=0; while head -c 19 "$PNPM_HOME/bin/mcpcat" 2>/dev/null | grep -q /usr/bin/env && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done; echo "settled $(readlink "$PNPM_HOME/bin/mcpcat" || echo kernel)"',
    'mcpcat --version',
    `pnpm remove -g ${MCPCAT} > /tmp/remove-$(id -u).log 2>&1; echo removed-$?`,
    'n=0; while { [ -e "$PNPM_HOME/bin/mcpcat" ] || [ -L "$PNPM_HOME/bin/mcpcat" ]; } && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done; ls -la "$PNPM_HOME/bin"; { [ -e "$PNPM_HOME/bin/mcpcat" ] || [ -L "$PNPM_HOME/bin/mcpcat" ]; } && echo link-left || echo no-link',
    'sleep 0.5; echo "kept $(readlink "$PNPM_HOME/bin/bash")"',
  ].join('; ');
  const version = SHIPPED.replaceAll('.', '\\.');
  const check = (text, bin, log) => {
    const [first, after = ''] = text.split(`settled ${bin === BIN ? '/usr/bin/mcpcat' : 'kernel'}`);
    assert.match(
      first,
      new RegExp(`^${version}$`, 'm'),
      `the first call didn't run mcpcat\n${text}\n${log}`
    );
    assert.doesNotMatch(first, /bad interpreter|No such file or directory/, `${text}\n${log}`);
    assert.match(first, new RegExp(`hashed ${bin}/mcpcat`), `${text}\n${log}`);
    assert.ok(after, `the Node link was never replaced\n${text}`);
    assert.match(after, new RegExp(`^${version}$`, 'm'), text);
    assert.match(after, /removed-0/, text);
    assert.match(after, /no-link/, text);
    assert.match(after, /kept \/usr\/bin\/bash/, text);
    assert.doesNotMatch(after, /bad interpreter|No such file or directory|link-left/, text);
  };
  await run(page, `clear; ${steps}; echo root-$((40 + 2))`);
  await shows(page, 'root-42', 10 * 60 * 1000).catch(async (error) => {
    throw new Error(`${error.message}\n${await screen(page)}`);
  });
  const rootLog = await sh(page, 'cat /tmp/add-0.log /tmp/remove-0.log');
  check((await screen(page)).replace(/ {2,}/g, '\n'), BIN, rootLog.out);

  const cone = '/home/cone/.local/share/pnpm/bin';
  await run(
    page,
    `clear; sudo -u cone bash -c '${`PATH=$PNPM_HOME/bin:$PATH; ${steps}`.replaceAll("'", "'\\''")}'; echo cone-$((40 + 2))`
  );
  await shows(page, 'cone-42', 10 * 60 * 1000).catch(async (error) => {
    throw new Error(`${error.message}\n${await screen(page)}`);
  });
  const coneLog = await sh(page, 'cat /tmp/add-1000.log /tmp/remove-1000.log');
  check((await screen(page)).replace(/ {2,}/g, '\n'), cone, coneLog.out);
  assert.deepEqual(page.errors, []);
});

test('bios#795: a user added after boot, whose pnpm home already holds a Node link, gets the kernel command without another write or a reload', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page);
  const home = '/home/ada/.local/share/pnpm';
  const node = `head -c 19 ${home}/bin/mcpcat 2>/dev/null | grep -q /usr/bin/env`;
  const prepared = await sh(
    page,
    `mkdir -p ${home} && HOME=/home/ada PNPM_HOME=${home} PATH=${home}/bin:$PATH pnpm add -g --config.minimum-release-age=0 ${MCPCAT}@${SHIPPED} > /tmp/ada.log 2>&1; echo added-$?; ${node} && echo node-before; chown -R 1001:1001 /home/ada && chmod 710 /home/ada && echo owned`
  );
  assert.match(
    prepared.out,
    /added-0\nnode-before\nowned/,
    `${prepared.out}\n${(await sh(page, 'cat /tmp/ada.log')).out}`
  );
  const added = await sh(
    page,
    `echo 'ada:x:1001:1001::/home/ada:/bin/bash' >> /etc/passwd; n=0; while ${node} && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done; ${node} && echo still-node || echo settled-after-$n; sudo -u ada bash -c 'PATH=$PNPM_HOME/bin:$PATH; mcpcat --version'`
  );
  t.diagnostic(added.out);
  assert.match(added.out, /^settled-after-\d+\n/, added.out);
  assert.match(added.out, new RegExp(`\\n${SHIPPED.replaceAll('.', '\\.')}$`), added.out);
  assert.deepEqual(page.errors, []);
});

test('bios#1153: a cone’s own kernel command that rm can’t remove, whether rm -f returns 0 or says Resource busy, starts no loop, stops no other package’s pass, warns once and leaves a panel install prompt', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  offer();
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await ready(page);
  const at = '$PNPM_HOME/global/v11/0000';
  const dir = `${at}/node_modules/${SELFISH}`;
  const entry = '"$PNPM_HOME/bin/selfish"';
  const manifest = {
    name: SELFISH,
    version: '1.0.0',
    bin: { selfish: 'selfish' },
    slicc: { abi: 'wasi', commands: { selfish: { script: 'selfish' } } },
  };
  const made = await sh(
    page,
    asCone(
      [
        `mkdir -p "$PNPM_HOME/bin" "${dir}"`,
        `echo '${JSON.stringify({ dependencies: { [SELFISH]: '1.0.0' } })}' > "${at}/package.json"`,
        `echo '${JSON.stringify(manifest)}' > "${dir}/package.json"`,
        `printf '#!/bin/sh\\n# /node_modules/${SELFISH}/\\necho selfish\\n' > "${dir}/selfish"`,
        `chmod 755 "${dir}/selfish"`,
        `n=0; until [ -e ${entry} ] || [ $n -ge 100 ]; do sleep 0.1; n=$((n + 1)); done`,
        `rm -f -- ${entry}; echo rm-$?`,
        `[ -e ${entry} ] && echo left`,
      ].join('; ')
    )
  );
  t.diagnostic(`rm -f on the kernel's own entry: ${made.out}`);
  assert.match(made.out, /\nleft$/, made.out);

  const noop = await pidGrowth(page);
  t.diagnostic(`new PIDs per 5 s with rm -f a no-op: ${noop.join(' ')}`);
  await install(page, 'hot-glue', { budget: PROMPT, stall: PROMPT });
  assert.ok(noop.at(-1) <= QUIET, `the loop kept running: ${noop.join(' ')} new PIDs per 5 s`);

  await page.evaluate(
    (command) => {
      void globalThis.unshadowClient
        .run(['bash', '-c', command], { cwd: '/' })
        .catch(() => undefined);
    },
    asCone(`exec 3< ${entry}; sleep 1100`)
  );
  const busy = async () =>
    (
      await sh(
        page,
        asCone(
          `n=0; e=; while [ $n -lt 100 ]; do e=$(rm -f -- ${entry} 2>&1) || break; e=; sleep 0.1; n=$((n + 1)); done; echo "$e"`
        )
      )
    ).out;
  assert.match(await busy(), /Resource busy/);

  const node = 'head -c 19 "$PNPM_HOME/bin/mcpcat" 2>/dev/null | grep -q /usr/bin/env';
  const added = await sh(
    page,
    asCone(
      `PATH=$PNPM_HOME/bin:$PATH; pnpm add -g --config.minimum-release-age=0 ${MCPCAT}@${SHIPPED} > /tmp/cone.log 2>&1; echo added-$?; n=0; while ${node} && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done; ${node} && echo still-node || echo settled-after-$n; mcpcat --version`
    )
  );
  t.diagnostic(added.out);
  assert.match(
    added.out,
    new RegExp(`added-0\\nsettled-after-\\d+\\n${SHIPPED.replaceAll('.', '\\.')}`),
    `${added.out}\n${(await sh(page, 'cat /tmp/cone.log')).out}`
  );
  assert.match(await busy(), /Resource busy/);

  const stuck = await pidGrowth(page);
  t.diagnostic(`new PIDs per 5 s with the entry busy: ${stuck.join(' ')}`);
  assert.ok(stuck.at(-1) <= QUIET, `the loop kept running: ${stuck.join(' ')} new PIDs per 5 s`);
  const warned = page.console.filter((line) => line.includes('Resource busy'));
  assert.ok(warned.length >= 1 && warned.length <= 3, warned.join('\n'));
  assert.deepEqual(page.errors, []);
});
