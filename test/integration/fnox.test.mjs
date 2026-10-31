import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { actPackage, boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';
import { policySeeded } from './policy-seeded.mjs';

const VALUE = 'dummy-fnox-value-0123456789';
const chrome = await launch({ timeout: 120000, intercept: [] });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

const FNOX = '@ai-ecoverse/wasi-fnox';
const packages = new URL('../../src/packages/', import.meta.url);
const text = (file) => readFileSync(new URL(file, packages), 'utf8');
const json = (file) => JSON.parse(text(file));

function beforeTheMove() {
  const base = json('package.json');
  const version = base.dependencies[FNOX];
  delete base.dependencies[FNOX];
  const lock = json('package-lock.json');
  delete lock.packages[`node_modules/${FNOX}`];
  delete lock.packages[''].dependencies[FNOX];
  const pnpm = text('pnpm-lock.yaml')
    .replace(
      new RegExp(`\n      '${FNOX}':\n        specifier: [^\n]+\n        version: [^\n]+`),
      ''
    )
    .replace(new RegExp(`\n  '${FNOX}@${version}':\n(    [^\n]+\n)+`), '\n')
    .replace(new RegExp(`\n  '${FNOX}@${version}': \\{\\}\n`), '\n');
  registry.latest.set(FNOX, version);
  const retired = json('optional/retired.json');
  const { [FNOX]: row, ...kept } = retired;
  const catalog = {
    ...json('optional/catalog.json'),
    [FNOX]: { id: row.id, label: row.label },
  };
  return {
    'package.json': JSON.stringify(base),
    'package-lock.json': JSON.stringify(lock),
    'pnpm-lock.yaml': pnpm,
    'optional/catalog.json': JSON.stringify(catalog),
    'optional/retired.json': JSON.stringify(kept),
  };
}

async function client(page) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    globalThis.fnoxClient ??= await globalThis.sliccKernelClient();
    globalThis.fnoxRuns ??= new Map();
  });
}

async function start(page, command, label) {
  await client(page);
  await page.evaluate(
    ({ command, label }) => {
      globalThis.fnoxRuns.set(
        label,
        globalThis.fnoxClient.run(['bash', '-c', command], { cwd: '/' }).then(
          ({ status, stdout, stderr }) => ({
            code: String(status),
            out: `${stdout ?? ''}${stderr ?? ''}`.trim(),
          }),
          (error) => ({ code: 'error', out: error.message })
        )
      );
    },
    { command, label }
  );
}

const finish = (page, label) => page.evaluate((label) => globalThis.fnoxRuns.get(label), label);

async function sh(page, command, label) {
  await start(page, command, label);
  return finish(page, label);
}

async function install(page) {
  await page
    .within(300000, () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'fnox' && item.state === 'available')
    )
    .catch(async (error) => {
      const rows = await page.evaluate(() =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .map((item) => `${item.id}:${item.state}`)
      );
      throw new Error(
        `${error.message}\nrows: ${rows.join(' ')}\n${page.console.join('\n').slice(-1500)}`
      );
    });
  const result = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.actPackage('fnox', 'install')
      .then(
        () => 'ok',
        (error) => error.message
      )
  );
  assert.equal(result, 'ok');
}

const config = (page) =>
  sh(page, 'cat /etc/fnox/config.toml; stat -c "%u %a" /etc/fnox/config.toml', 'config');

async function decide(page, decision) {
  const request = await page.within(
    60000,
    () => document.querySelector('slicc-app').model.approvals?.list()[0]
  );
  await page.evaluate(
    ({ id, decision }) => document.querySelector('slicc-app').model.approvals.decide(id, decision),
    { id: request.id, decision }
  );
  return request;
}

test('fnox in seven: its config is root’s /etc/fnox, a cone reads it and can’t write it, sudo writes it only when allowed, and values stay in the vault', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  const seeded = await config(page);
  assert.equal(seeded.code, '0', seeded.out);
  assert.match(seeded.out, /default_provider = "seven"/);
  assert.match(seeded.out, /\n0 644$/);

  const set = await sh(
    page,
    `cd /etc/fnox && printf '%s' '${VALUE}' | fnox set --global HARBOR_TOKEN`,
    'set'
  );
  assert.equal(set.code, '0', set.out);
  const after = await config(page);
  const placeholder = /HARBOR_TOKEN\s*=\s*\{[^}]*value = "(fnox_proxy_[0-9a-f]{24})"/.exec(
    after.out
  )?.[1];
  assert.ok(placeholder, `${after.out}\nset: ${set.out}`);
  assert.ok(!after.out.includes(VALUE));

  const got = await sh(page, 'cd /tmp && sudo -u cone fnox get HARBOR_TOKEN', 'get');
  assert.deepEqual(got, { code: '0', out: placeholder });

  const wrote = await sh(
    page,
    `sudo -u cone sh -c 'echo "EVIL = 1" >> /etc/fnox/config.toml'`,
    'write'
  );
  assert.notEqual(wrote.code, '0');
  assert.match(wrote.out, /Permission denied|EACCES/);
  assert.equal((await config(page)).out, after.out);

  await start(
    page,
    `cd /tmp && printf '%s' 'dummy-dock-value-0123456789' | sudo -u cone sudo fnox set --global DOCK_TOKEN`,
    'deny'
  );
  const denied = await decide(page, 'deny');
  assert.match(denied.command, /fnox set --global DOCK_TOKEN/);
  const denyRun = await finish(page, 'deny');
  assert.notEqual(denyRun.code, '0', denyRun.out);
  assert.doesNotMatch((await config(page)).out, /DOCK_TOKEN/);

  await start(
    page,
    `cd /tmp && printf '%s' 'dummy-dock-value-0123456789' | sudo -u cone sudo fnox set --global DOCK_TOKEN`,
    'once'
  );
  const once = await decide(page, 'once');
  assert.equal(once.always, false);
  const onceRun = await finish(page, 'once');
  assert.equal(onceRun.code, '0', onceRun.out);
  assert.match((await config(page)).out, /DOCK_TOKEN\s*=\s*\{/);

  const exec = await sh(
    page,
    `cd /tmp && sudo -u cone fnox exec -- /bin/sh -c 'printf %s "$HARBOR_TOKEN" | wc -c; printenv HARBOR_TOKEN'`,
    'exec'
  );
  const debug = JSON.stringify(
    chrome.vault.log
      .filter((entry) => ['materialized', 'consumed', 'sealed'].includes(entry.op))
      .slice(-6)
  );
  assert.deepEqual(exec, { code: '0', out: `${VALUE.length}\n${placeholder}` }, debug);
  assert.ok(
    chrome.vault.log.some(
      (entry) => entry.op === 'materialized' && entry.names.includes('HARBOR_TOKEN')
    )
  );
  assert.ok(chrome.vault.log.some((entry) => entry.op === 'consumed' && entry.ok));

  const leaked = await sh(
    page,
    `sudo -u cone grep -rlsF -e '${VALUE}' -e dummy-dock-value /home /tmp /etc /var /usr /opt /mnt; echo "listed"`,
    'leak'
  );
  assert.equal(leaked.out, 'listed');
  assert.deepEqual(page.errors, []);
});

test('without the vault, fnox’s sealed operations fail closed with ENOTCONN', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const dead = await new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) localStorage.setItem('slicc-os.vault-origin', ${JSON.stringify(dead)}); }`
  );
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  await page.within(
    30000,
    () => document.querySelector('slicc-app').model.vault.availability() === 'waiting'
  );
  const set = await sh(
    page,
    `cd /etc/fnox && printf '%s' '${VALUE}' | fnox set --global HARBOR_TOKEN`,
    'offline'
  );
  assert.notEqual(set.code, '0');
  assert.match(set.out, /ENOTCONN|isn.t connected/, set.out);
  assert.doesNotMatch((await config(page)).out, /HARBOR_TOKEN/);
  assert.deepEqual(page.errors, []);
});

const modes = (page, label) =>
  sh(
    page,
    'stat -c "%u %g %a %F" /etc/fnox /etc/fnox/config.toml; grep -c "^DOCK_NOTE = " /etc/fnox/config.toml',
    label
  );

test('policy seeding preserves root contents and existing metadata across reloads, including tampering until root repairs it', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  await policySeeded(page);
  const initial = await config(page);
  assert.equal(initial.code, '0', initial.out);
  assert.match(initial.out, /default_provider = "seven"/);
  assert.match(initial.out, /\n0 644$/);
  const appended = await sh(page, "printf 'DOCK_NOTE = 1\\n' >> /etc/fnox/config.toml", 'append');
  assert.equal(appended.code, '0', appended.out);
  const expected = { code: '0', out: '0 0 755 directory\n0 0 644 regular file\n1' };
  assert.deepEqual(await modes(page, 'appended'), expected);
  await page.reload();
  await ready(page);
  assert.deepEqual(await modes(page, 'kept'), expected);
  for (const [label, broken] of [
    ['chmod', 'chmod 0600 /etc/fnox/config.toml'],
    ['chown', 'chown 1000:1000 /etc/fnox/config.toml'],
    ['dir', 'chmod 0775 /etc/fnox'],
  ]) {
    const broke = await sh(page, broken, `${label}-break`);
    assert.equal(broke.code, '0', broke.out);
    const tampered = await modes(page, `${label}-before`);
    assert.notDeepEqual(tampered, expected);
    await page.reload();
    await ready(page);
    assert.deepEqual(await modes(page, `${label}-preserved`), tampered);
    assert.match((await config(page)).out, /DOCK_NOTE = 1/);
    const repair = await sh(
      page,
      'chown 0:0 /etc/fnox /etc/fnox/config.toml; chmod 0755 /etc/fnox; chmod 0644 /etc/fnox/config.toml',
      `${label}-repair`
    );
    assert.equal(repair.code, '0', repair.out);
    await page.reload();
    await ready(page);
    await policySeeded(page);
    assert.deepEqual(await modes(page, `${label}-repaired`), expected);
  }
  assert.deepEqual(page.errors, []);
});

test('fnox is in the base set: on a fresh profile, without any install, fnox env and fnox proxy rules answer as root and as the cone, and login shells and sudo keep FNOX_CONFIG_DIR', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  const row = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .find((item) => item.id === 'fnox')
  );
  assert.equal(row, undefined, JSON.stringify(row));
  for (const [who, prefix] of [
    ['root', ''],
    ['cone', 'sudo -u cone '],
  ]) {
    const env = await sh(page, `cd /tmp && ${prefix}fnox env --json --describe`, `env-${who}`);
    assert.equal(env.code, '0', `${who}: ${env.out}`);
    assert.doesNotThrow(() => JSON.parse(env.out), `${who}: ${env.out}`);
    const rules = await sh(page, `cd /tmp && ${prefix}fnox proxy rules --json`, `rules-${who}`);
    if (rules.code === '0')
      assert.doesNotThrow(() => JSON.parse(rules.out), `${who}: ${rules.out}`);
    else
      assert.match(
        rules.out,
        /No \[proxy\] configuration found|no rules are configured/,
        `${who}: ${rules.out}`
      );
  }
  const dirs = await sh(
    page,
    `bash -lc 'printenv FNOX_CONFIG_DIR'; sudo -u cone bash -lc 'printenv FNOX_CONFIG_DIR'; sudo -u cone printenv FNOX_CONFIG_DIR`,
    'dirs'
  );
  assert.deepEqual(dirs, { code: '0', out: '/etc/fnox\n/etc/fnox\n/etc/fnox' });
  const seeded = await config(page);
  assert.match(seeded.out, /default_provider = "seven"/);
  assert.match(seeded.out, /\n0 644$/);
  assert.deepEqual(page.errors, []);
});

test('fnox exec runs in a project with an as_file secret: the plain secret reaches the command, the as_file one is left unset with a warning (homescoop#945)', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  const project = [
    'mkdir -p /tmp/fnox-asfile && cd /tmp/fnox-asfile',
    `printf '[secrets]\\nHARBOR_PLAIN = { provider = "plain", value = "tide-plain-42" }\\nCERT = { provider = "plain", value = "pem-data", as_file = true }\\n\\n[providers.plain]\\ntype = "plain"\\n' > fnox.toml`,
  ].join(' && ');
  const ran = await sh(
    page,
    `${project} && fnox exec -- /bin/sh -c 'echo "plain=$HARBOR_PLAIN"; echo "cert=\${CERT-unset}"' 2>&1`,
    'asfile'
  );
  assert.equal(ran.code, '0', ran.out);
  assert.match(ran.out, /plain=tide-plain-42/, ran.out);
  assert.match(ran.out, /cert=unset/, ran.out);
  assert.match(ran.out, /CERT is not set: it is an as_file secret/, ran.out);
  assert.doesNotMatch(ran.out, /pem-data/, ran.out);
  assert.deepEqual(page.errors, []);
});

test('a profile that installed fnox from the catalog keeps a working fnox once fnox moves into the base set, its catalog row is retired, not installed again, and removing it leaves the base set’s fnox', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const old = beforeTheMove();
  for (const [file, body] of Object.entries(old)) chrome.overrides.set(`/packages/${file}`, body);
  t.after(() => {
    for (const file of Object.keys(old)) chrome.overrides.delete(`/packages/${file}`);
  });
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  await install(page);
  const before = await sh(page, 'cd /tmp && fnox --version', 'before');
  assert.equal(before.code, '0', before.out);

  for (const file of Object.keys(old)) chrome.overrides.delete(`/packages/${file}`);
  await page.reload();
  await ready(page);
  await page
    .within(600000, () => {
      const { updates } = document.querySelector('slicc-app').model;
      const fnox = updates.packages().find((item) => item.id === 'fnox');
      return (
        updates.ready() &&
        fnox?.state === 'installed' &&
        fnox.offered === null &&
        updates
          .list()
          .every((row) => !/queued|starting|checking|downloading|linking/.test(row.state))
      );
    })
    .catch(async (error) => {
      const seen = await page.evaluate(() => {
        const { updates } = document.querySelector('slicc-app').model;
        const fnox = updates.packages().find((item) => item.id === 'fnox');
        return {
          ready: updates.ready(),
          fnox: fnox && { state: fnox.state, offered: fnox.offered },
          rows: updates.list().map((row) => `${row.id}:${row.state}`),
        };
      });
      throw new Error(`${error.message}\n${JSON.stringify(seen)}`);
    });
  const row = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .find((item) => item.id === 'fnox')
  );
  assert.deepEqual([row.state, row.actions], ['installed', ['remove']]);
  const after = await sh(
    page,
    'cd /tmp && fnox --version && sudo -u cone fnox env --json --describe > /dev/null',
    'after'
  );
  assert.equal(after.code, '0', after.out);
  assert.equal(await actPackage(page, 'fnox', 'remove'), 'ok');
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'fnox')
    ),
    false
  );
  const removed = await sh(
    page,
    'cd /tmp && fnox --version && sudo -u cone fnox env --json --describe > /dev/null && test ! -e /usr/local/share/pnpm/bin/fnox && command -v fnox',
    'removed'
  );
  assert.equal(removed.code, '0', removed.out);
  assert.match(removed.out, /\n\/usr\/bin\/fnox$/, removed.out);
  assert.deepEqual(page.errors, []);
});
