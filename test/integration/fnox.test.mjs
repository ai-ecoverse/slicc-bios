import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { boot, run } from './bios.mjs';
import { launch } from './chrome.mjs';

const VALUE = 'dummy-fnox-value-0123456789';
const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

let calls = 0;

async function sh(page, command, label) {
  calls += 1;
  const name = `${label}-${calls}`;
  await run(
    page,
    `clear; mkdir -p /root/out; rm -f /root/out/${name}.*; ( ${command} ) > /root/out/${name}.txt 2>&1; echo $? > /root/out/${name}.done`
  );
  await page.within(
    300000,
    async (name) => {
      const out = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('root'))
        .getDirectoryHandle('out')
        .catch(() => null);
      const done = await out?.getFileHandle(`${name}.done`).catch(() => null);
      return done ? (await done.getFile()).size > 0 : false;
    },
    name
  );
  return page.evaluate(async (name) => {
    const out = await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle('root')
    ).getDirectoryHandle('out');
    const text = async (file) => (await (await out.getFileHandle(file)).getFile()).text();
    return { code: (await text(`${name}.done`)).trim(), out: (await text(`${name}.txt`)).trim() };
  }, name);
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

  await run(
    page,
    `clear; cd /tmp && printf '%s' 'dummy-dock-value-0123456789' | sudo -u cone sudo fnox set --global DOCK_TOKEN > /root/out/deny.txt 2>&1; echo $? > /root/out/deny.done`
  );
  const denied = await decide(page, 'deny');
  assert.match(denied.command, /fnox set --global DOCK_TOKEN/);
  await page.within(60000, async () => {
    const out = await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle('root')
    ).getDirectoryHandle('out');
    return (await (await out.getFileHandle('deny.done').catch(() => null))?.getFile())?.size > 0;
  });
  assert.doesNotMatch((await config(page)).out, /DOCK_TOKEN/);

  await run(
    page,
    `clear; cd /etc/fnox && printf '%s' 'dummy-dock-value-0123456789' | sudo -u cone sudo fnox set --global DOCK_TOKEN > /root/out/once.txt 2>&1; echo $? > /root/out/once.done`
  );
  const once = await decide(page, 'once');
  assert.equal(once.always, false);
  await page.within(60000, async () => {
    const out = await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle('root')
    ).getDirectoryHandle('out');
    return (await (await out.getFileHandle('once.done').catch(() => null))?.getFile())?.size > 0;
  });
  assert.match((await config(page)).out, /DOCK_TOKEN\s*=\s*\{/);

  const exec = await sh(page, 'cd /tmp && sudo -u cone fnox exec -- printenv HARBOR_TOKEN', 'exec');
  assert.deepEqual(exec, { code: '0', out: VALUE });
  assert.ok(
    chrome.vault.log.some(
      (entry) => entry.op === 'materialized' && entry.names.includes('HARBOR_TOKEN')
    )
  );
  assert.ok(chrome.vault.log.some((entry) => entry.op === 'consumed' && entry.ok));

  const leaked = await sh(
    page,
    `sudo -u cone grep -rlsF -e '${VALUE}' -e dummy-dock-value /home /tmp /etc /var /usr /opt /mnt; echo "grep $?"`,
    'leak'
  );
  assert.match(leaked.out, /grep 1$/, leaked.out);
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
