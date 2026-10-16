import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const VALUE = 'dummy-fnox-value-0123456789';
const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

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
  await page.within(300000, () =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'fnox' && item.state === 'available')
  );
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
  await install(page);
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
  await install(page);
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
