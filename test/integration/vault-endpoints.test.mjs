import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const AZURE = { name: 'AZURE_OPENAI_API_KEY', url: 'https://example.openai.azure.com/openai' };
const DOCS = { server: 'docs', url: 'https://mcp.example.com/mcp' };
const SECRET = 'key=s3cr3t-value';

const fields = () =>
  chrome.vault.log.filter((entry) => entry.op === 'endpoints-fields').map((entry) => entry.fields);

async function ready(page) {
  await page.within(
    60000,
    () => document.querySelector('slicc-app')?.model?.vault?.availability?.() === 'ready'
  );
}

async function logged(count) {
  for (let tries = 0; tries < 100 && fields().length < count; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fields();
}

const endpoints = (page, change) => port(page, 'endpoints', change);

const port = (page, method, ...args) =>
  page.evaluate(
    ([method, args]) =>
      document
        .querySelector('slicc-app')
        .model.vault[method](...args)
        .then(
          (reply) => ({ reply }),
          (error) => ({ code: error.code, message: error.message })
        ),
    [method, args]
  );

const vaultList = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.vault.list()?.secrets ?? []);

test('Settings’ endpoint changes reach the vault’s page op flattened, as add’s model and mcp beside remove and unpin, a follower tab’s own Settings uses its own page port, and a refused URL is named without its query', async (t) => {
  t.after(() => chrome.vault.set({ secrets: [] }));
  chrome.vault.set({
    records: [
      {
        kind: 'model',
        name: AZURE.name,
        value: 'azure-key-value',
        source: 'settings',
        placeholder: 'fnox_proxy_000000000000000000000a2e',
        provider: 'azure-openai-responses',
      },
      {
        kind: 'mcp',
        name: 'TIDE_MCP_TOKEN',
        value: 'tide-token-value',
        source: 'settings',
        placeholder: 'fnox_proxy_000000000000000000000713',
        server: 'tide',
        url: 'https://mcp.tide.example/mcp',
        pinned: true,
      },
    ],
    version: 1,
  });
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const tide = (await vaultList(page)).find((record) => record.name === 'TIDE_MCP_TOKEN');
  assert.deepEqual([tide.url, tide.pinned], ['https://mcp.tide.example/mcp', true]);
  const before = fields().length;
  assert.deepEqual(await endpoints(page, { add: { model: [AZURE] } }), { reply: { ok: true } });
  assert.deepEqual(await endpoints(page, { remove: { model: [AZURE] } }), { reply: { ok: true } });
  assert.deepEqual(
    await endpoints(page, {
      add: { mcp: [DOCS] },
      remove: { mcp: [{ ...DOCS, url: 'https://old.example.com/mcp' }] },
    }),
    { reply: { ok: true } }
  );
  assert.deepEqual(await port(page, 'unpin', ['TIDE_MCP_TOKEN']), { reply: { ok: true } });
  assert.deepEqual((await logged(before + 4)).slice(before), [
    { model: [AZURE] },
    { remove: { model: [AZURE] } },
    { mcp: [DOCS], remove: { mcp: [{ ...DOCS, url: 'https://old.example.com/mcp' }] } },
    { unpin: ['TIDE_MCP_TOKEN'] },
  ]);
  await page.within(30000, () =>
    document
      .querySelector('slicc-app')
      .model.vault.list()
      ?.secrets.some((record) => record.name === 'TIDE_MCP_TOKEN' && !record.pinned && !record.url)
  );

  const refused = await endpoints(page, {
    add: { model: [{ name: 'K', url: `http://example.com/v1?${SECRET}#part` }] },
  });
  assert.equal(refused.code, 'EINVAL');
  assert.match(refused.message, /^http:\/\/example\.com\/v1 must be an https: URL/);
  assert.doesNotMatch(refused.message, /s3cr3t|#part/);

  const second = await page.tab();
  await second.goto('/');
  await second.until(
    () => document.querySelector('slicc-app')?.model?.tabs?.state().role === 'follower'
  );
  await ready(second);
  const followed = fields().length;
  assert.deepEqual(await endpoints(second, { add: { model: [AZURE] } }), { reply: { ok: true } });
  assert.deepEqual((await logged(followed + 1)).slice(followed), [{ model: [AZURE] }]);
  assert.ok(!JSON.stringify(page.console).includes('s3cr3t'), 'a URL’s query reached the console');
  assert.deepEqual(page.errors, []);
  assert.deepEqual(second.errors, []);
});

test('Settings changes a model record’s settings with a put that carries no value, so the key and its placeholder stay, and a record the vault doesn’t hold fails with the vault’s ENOENT', async (t) => {
  t.after(() => chrome.vault.set({ secrets: [] }));
  chrome.vault.set({
    records: [
      {
        kind: 'model',
        name: 'CLOUDFLARE_API_KEY',
        value: 'cloudflare-key-value',
        source: 'settings',
        placeholder: 'fnox_proxy_0000000000000000000000cf',
        provider: 'cloudflare-workers-ai',
        settings: { accountId: 'old-account' },
      },
    ],
    version: 1,
  });
  const page = await chrome.page(t);
  await boot(page);
  await ready(page);
  const before = chrome.vault.log.length;
  assert.deepEqual(
    await port(page, 'settings', 'CLOUDFLARE_API_KEY', 'model', { accountId: 'new-account' }),
    {
      reply: {
        name: 'CLOUDFLARE_API_KEY',
        placeholder: 'fnox_proxy_0000000000000000000000cf',
        state: 'inert',
      },
    }
  );
  const settingsPuts = () =>
    chrome.vault.log.slice(before).filter((entry) => entry.op === 'settings-put');
  for (let tries = 0; tries < 100 && !settingsPuts().length; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const sent = settingsPuts();
  assert.deepEqual(
    sent.map((entry) => entry.fields),
    [['kind', 'name', 'settings']]
  );
  const record = await page.within(30000, () =>
    document
      .querySelector('slicc-app')
      .model.vault.list()
      ?.secrets.find(
        (item) => item.name === 'CLOUDFLARE_API_KEY' && item.settings?.accountId === 'new-account'
      )
  );
  assert.equal(record.placeholder, 'fnox_proxy_0000000000000000000000cf');
  const saved = async () => {
    for (let tries = 0; tries < 100; tries += 1) {
      const found = chrome.vault.state.records?.find((item) => item.name === 'CLOUDFLARE_API_KEY');
      if (found?.settings?.accountId === 'new-account') return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  };
  assert.equal((await saved())?.value, 'cloudflare-key-value');
  const missing = await port(page, 'settings', 'NO_SUCH_KEY', 'model', { accountId: 'x' });
  assert.equal(missing.code, 'ENOENT');
  assert.match(missing.message, /NO_SUCH_KEY/);
  assert.deepEqual(page.errors, []);
});

test('a kernel program, root or a cone, that asks /dev/sealed for endpoints, an unpin or a put without a value is refused, and nothing reaches the vault', async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await boot(page);
  await ready(page);
  const before = chrome.vault.log.length;
  const asks = [
    [
      '{"v":1,"op":"endpoints","model":[{"name":"K","url":"https://evil.example/"}]}',
      /endpoints are set only by seven['’]s own Settings on this device/,
    ],
    [
      '{"v":1,"op":"endpoints","unpin":["K"]}',
      /endpoints are set only by seven['’]s own Settings on this device/,
    ],
    [
      '{"v":1,"op":"put","name":"K","kind":"model","settings":{"a":"b"}}',
      /settings are changed only by seven['’]s own Settings on this device/,
    ],
  ];
  for (const [as, prefix] of [
    ['root', 'sh -c'],
    ['cone', 'sudo -u cone sh -c'],
  ]) {
    for (const [index, [request, refusal]] of asks.entries()) {
      const ask = `exec 3<>/dev/sealed; if printf %s '${request}' >&3 2>/dev/null; then head -c 300 <&3; else echo kernel-refused; fi`;
      await run(
        page,
        `clear; ${prefix} '${ask.replaceAll("'", "'\\''")}'; echo; echo ${as}-asked-${index}-$((40 + 2))`
      );
      await shows(page, `${as}-asked-${index}-42`);
      const text = await screen(page);
      assert.doesNotMatch(text, /"ok"|"placeholder"/, `${as} ${index}: ${text}`);
      assert.match(
        text,
        new RegExp(`kernel-refused|EACCES[^\\n]*${refusal.source}`),
        `${as} ${index}: ${text}`
      );
    }
  }
  const reached = chrome.vault.log
    .slice(before)
    .filter(
      (entry) =>
        ['endpoints-fields', 'settings-put'].includes(entry.op) ||
        ['endpoints', 'put'].includes(entry.sealed)
    );
  assert.deepEqual(reached, []);
  assert.deepEqual(page.errors, []);
});

test('no other channel offers the vault: a follower’s os channel to the owner answers it has none, and the kernel’s link facade on 7400 refuses a vault stream', async (t) => {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ users: 'enforce' })}`);
  await boot(page);
  await ready(page);
  const before = chrome.vault.log.length;
  const second = await page.tab();
  await second.goto('/');
  await second.until(
    () => document.querySelector('slicc-app')?.model?.tabs?.state().role === 'follower'
  );
  const os = await second.evaluate(async () => {
    const { joinSwitchboard, osClient } = await import('/os/tabs.js');
    const board = await joinSwitchboard({ visible: false });
    const { os } = await board.ports(['os']);
    const client = osClient(os);
    const outcome = (call) =>
      call.then(
        () => 'answered',
        (error) => error.message
      );
    return {
      vault: await outcome(client.call('vault')),
      endpoints: await outcome(client.call('endpoints', { model: [] })),
      network: await outcome(client.call('networkCall', 'endpoints', { model: [] })),
    };
  });
  assert.deepEqual(os, {
    vault: 'the tab running SLICC has no vault',
    endpoints: 'the tab running SLICC has no endpoints',
    network: 'the network port has no endpoints',
  });

  const hello = JSON.stringify({
    v: 1,
    join: '/join/j1',
    open: { kind: 'vault', op: 'endpoints' },
  });
  const length = Buffer.byteLength(hello);
  const head = [1, length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255]
    .map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`)
    .join('');
  await page.send('Page.bringToFront');
  await run(
    page,
    `clear; exec 3<>/dev/tcp/127.0.0.1/7400; printf '${head}%s' '${hello}' >&3; timeout 10 head -c 300 <&3 | tr -c '[:print:]' '.'; echo; echo facade-$((40 + 2))`
  );
  await shows(page, 'facade-42', 60000);
  assert.match(
    await screen(page),
    /\{"reset":"EOPNOTSUPP: the link facade opens only agent prompt, watch and abort streams"\}/
  );
  const reached = chrome.vault.log.slice(before).filter((entry) => entry.op === 'endpoints-fields');
  assert.deepEqual(reached, []);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(second.errors, []);
});
