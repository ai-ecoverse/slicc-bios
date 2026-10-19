import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { actPackage, boot, ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const VALUE = 'dummy-mcp-value-0123456789';
const URL_HTTP = 'http://127.0.0.1:8470/mcp';
const fixture = new URL('fixtures/mcp-fixture/', import.meta.url);
const optional = JSON.parse(
  await readFile(new URL('../../src/packages/optional/package.json', import.meta.url), 'utf8')
);
const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

async function client(page) {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  await page.evaluate(async () => {
    globalThis.mcpcatClient ??= await globalThis.sliccKernelClient();
    globalThis.mcpcatRuns ??= new Map();
  });
}

async function start(page, command, label) {
  await client(page);
  await page.evaluate(
    ({ command, label }) => {
      globalThis.mcpcatRuns.set(
        label,
        globalThis.mcpcatClient.run(['bash', '-c', command], { cwd: '/' }).then(
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

async function sh(page, command, label) {
  await start(page, command, label);
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
  await ready(page);
}

async function listening(page) {
  for (let tries = 0; tries < 60; tries++) {
    const log = await sh(page, 'cat /tmp/mcp-fixture.log 2>/dev/null', `log-${tries}`);
    if (log.out.includes('listening 8470')) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.fail('the HTTP fixture never listened on 8470');
}

test('mcpcat from the catalog lists and calls a stdio and an HTTP MCP server, and a vault secret in a header reaches the server but never mcpcat’s output', {
  timeout: 25 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await boot(page);
  await install(page, 'mcpcat');
  const row = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .find((item) => item.id === 'mcpcat')
  );
  assert.equal(row.version, optional.dependencies['@ai-ecoverse/mcpcat']);
  await installFixture(page);

  const version = await sh(page, 'mcpcat --version', 'version');
  assert.equal(version.code, '0', version.out);
  assert.match(version.out, new RegExp(optional.dependencies['@ai-ecoverse/mcpcat']));

  const stdioTools = await sh(page, 'cd /tmp && mcpcat tools stdio:mcp-fixture', 'stdio-tools');
  assert.deepEqual(stdioTools, { code: '0', out: 'add  Adds two numbers' });
  const stdioCall = await sh(
    page,
    'cd /tmp && mcpcat call stdio:mcp-fixture add --a 2 --b 3',
    'stdio-call'
  );
  assert.deepEqual(stdioCall, { code: '0', out: '5' });

  await start(page, 'mcp-fixture http 8470 > /tmp/mcp-fixture.log 2>&1', 'server');
  await listening(page);
  const httpTools = await sh(page, `cd /tmp && mcpcat tools ${URL_HTTP}`, 'http-tools');
  assert.deepEqual(httpTools, { code: '0', out: 'add  Adds two numbers' });
  const httpCall = await sh(
    page,
    `cd /tmp && mcpcat call ${URL_HTTP} add --a 2 --b 3`,
    'http-call'
  );
  assert.deepEqual(httpCall, { code: '0', out: '5' });

  const set = await sh(
    page,
    `cd /etc/fnox && printf '%s' '${VALUE}' | fnox set --global MCP_TOKEN`,
    'set'
  );
  assert.equal(set.code, '0', set.out);
  const placeholder = await sh(page, 'cd /tmp && fnox get MCP_TOKEN', 'get');
  assert.equal(placeholder.code, '0', placeholder.out);
  assert.match(placeholder.out, /^fnox_proxy_[0-9a-f]{24}$/);

  const secret = await sh(
    page,
    `cd /tmp && fnox exec -- mcpcat -v -H 'X-Api: \${MCP_TOKEN}' call ${URL_HTTP} add --a 2 --b 3`,
    'secret'
  );
  assert.equal(secret.code, '0', secret.out);
  assert.match(secret.out, /^5$/m);
  assert.match(secret.out, /^> X-Api: \[REDACTED\]$/m);
  assert.ok(!secret.out.includes(VALUE), secret.out);
  assert.ok(!secret.out.includes(placeholder.out), secret.out);

  const log = await sh(page, 'cat /tmp/mcp-fixture.log', 'seen');
  assert.ok(log.out.includes(`seen ${[...VALUE].reverse().join('')}`), log.out);

  const leaked = await sh(
    page,
    `grep -rlsF -e '${VALUE}' /home /tmp /etc /var /usr /opt /mnt; echo "listed"`,
    'leak'
  );
  assert.equal(leaked.out, 'listed');
  assert.deepEqual(page.errors, []);
});
