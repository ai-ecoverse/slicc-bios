import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { actPackage, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const ROOT_SHELL = ['slicc:/home# '];
const URL_HTTP = 'http://127.0.0.1:8470/mcp';
const fixture = new URL('fixtures/mcp-fixture/', import.meta.url);
const chrome = await launch({ tools: false, timeout: 120000 });
after(() => chrome.close());

async function client(page) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    globalThis.mcpcatClient ??= await globalThis.sliccKernelClient();
    globalThis.mcpcatRuns ??= new Map();
  });
}

async function start(page, command, label, user = null) {
  await client(page);
  await page.evaluate(
    ({ command, label, user }) => {
      globalThis.mcpcatRuns.set(
        label,
        globalThis.mcpcatClient
          .run(['bash', '-c', command], user ? { cwd: `/home/${user}`, user } : { cwd: '/' })
          .then(
            ({ status, stdout, stderr }) => ({
              code: String(status),
              out: `${stdout ?? ''}${stderr ?? ''}`.trim(),
            }),
            (error) => ({ code: 'error', out: error.message })
          )
      );
    },
    { command, label, user }
  );
}

async function sh(page, command, label, user = null) {
  await start(page, command, label, user);
  return page.evaluate((label) => globalThis.mcpcatRuns.get(label), label);
}

async function install(page, id) {
  await page.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id && item.state === 'available'),
    id
  );
  assert.equal(await actPackage(page, id, 'install'), 'ok', id);
}

async function installFixture(page) {
  const files = {};
  for (const name of ['package.json', 'index.mjs'])
    files[`node_modules/mcp-fixture/${name}`] = (await readFile(new URL(name, fixture))).toString(
      'base64'
    );
  await page.evaluate(async (files) => {
    for (const [path, data] of Object.entries(files)) {
      const names = path.split('/');
      const name = names.pop();
      let dir = await navigator.storage.getDirectory();
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      await writable.close();
    }
  }, files);
  await page.reload();
  await ready(page, ROOT_SHELL);
}

async function listening(page) {
  for (let tries = 0; tries < 60; tries++) {
    const log = await sh(page, 'cat /tmp/mcp-fixture.log 2>/dev/null', `log-${tries}`);
    if (log.out.includes('listening 8470')) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.fail('the HTTP fixture never listened on 8470');
}

test('under users=enforce, cone runs the catalog’s mcpcat with a private mcp.json of its own, never sees root’s, and can’t change the install', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto('/#users=enforce');
  await ready(page, ROOT_SHELL);
  await install(page, 'mcpcat');
  await installFixture(page);
  await start(page, 'mcp-fixture http 8470 > /tmp/mcp-fixture.log 2>&1', 'server');
  await listening(page);

  const mine = await sh(page, `mcpcat add rootsrv ${URL_HTTP}`, 'root-add');
  assert.equal(mine.code, '0', mine.out);
  const config = mine.out.match(/in (\/\S+\/mcp\.json)/)?.[1];
  assert.ok(config, mine.out);
  const added = await sh(
    page,
    `mcpcat add docs ${URL_HTTP} -H 'Authorization: Bearer \${DOCS_TOKEN}'`,
    'cone-add',
    'cone'
  );
  assert.equal(added.code, '0', added.out);
  assert.match(added.out, /\/home\/cone\/\.pi\/agent\/mcp\.json/);

  const modes = await sh(
    page,
    "stat -c '%n %U %a' ~/.pi ~/.pi/agent ~/.pi/agent/mcp.json",
    'modes',
    'cone'
  );
  assert.match(modes.out, /^\/home\/cone\/\.pi\/agent\/mcp\.json cone 600$/m, modes.out);
  assert.match(modes.out, /^\/home\/cone\/\.pi\/agent cone 700$/m, modes.out);

  const theirs = await sh(page, 'mcpcat list', 'cone-list', 'cone');
  assert.equal(theirs.code, '0', theirs.out);
  assert.match(theirs.out, /^docs\s/m, theirs.out);
  assert.doesNotMatch(theirs.out, /rootsrv/, theirs.out);
  const root = await sh(page, 'mcpcat list', 'root-list');
  assert.match(root.out, /^rootsrv\s/m, root.out);
  assert.doesNotMatch(root.out, /^docs\s/m, root.out);

  const call = await sh(page, 'mcpcat call docs add --a 2 --b 3', 'cone-call', 'cone');
  assert.equal(call.code, '0', call.out);
  assert.match(call.out, /^5$/m, call.out);
  assert.match(call.out, /unset variable DOCS_TOKEN/, call.out);

  const peek = await sh(
    page,
    `cat ${config} 2>&1 >/dev/null; echo root-config=$?; f=$(ls -d /usr/local/share/pnpm/global/v11/*/node_modules/@ai-ecoverse/mcpcat | head -1); echo x >> "$f/package.json" 2>/dev/null; echo install=$?; echo x > "$f/dist/kernel/mcpcat.mjs" 2>/dev/null; echo bundle=$?`,
    'peek',
    'cone'
  );
  assert.match(peek.out, /Permission denied\nroot-config=1$/m, peek.out);
  assert.match(peek.out, /^install=[1-9]/m, peek.out);
  assert.match(peek.out, /^bundle=[1-9]/m, peek.out);
  const intact = await sh(page, 'mcpcat --version', 'version', 'cone');
  assert.equal(intact.code, '0', intact.out);
  assert.deepEqual(page.errors, []);
});
