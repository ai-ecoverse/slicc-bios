import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeLlm } from './fake-llm.mjs';
import { realVault } from './real-vault.mjs';

const HOST = 'https://forward.example.test/';
const ORDINARY = 'synthetic-ordinary-credential-00000000';
const MCP = 'synthetic-mcp-credential-00000000';
const chrome = await launch({ vault: false });
const vault = await realVault(new URL(chrome.url).origin);
const bearer = (request) =>
  request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
const upstream = await fakeLlm(chrome.cdp, {
  hosts: [HOST],
  answer(request, body) {
    const path = new URL(request.url).pathname;
    const wanted = path.startsWith('/mcp') ? MCP : ORDINARY;
    if (bearer(request) !== `Bearer ${wanted}`) return { status: 401, body: 'unauthorized' };
    const headers = [
      ['content-type', 'application/json'],
      ['x-echo', wanted],
    ];
    if (path === '/ordinary' || path === '/mcp/body')
      return {
        status: 200,
        headers,
        body: JSON.stringify({ echo: wanted, body: body.toString() }),
      };
    if (request.method === 'GET') return { status: 405, headers, body: '' };
    const packet = JSON.parse(body.toString());
    if (packet.method.startsWith('notifications/')) return { status: 202, headers, body: '' };
    const result =
      packet.method === 'initialize'
        ? {
            protocolVersion: packet.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'unit', version: '1' },
          }
        : { tools: [] };
    return {
      status: 200,
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }),
    };
  },
});

after(async () => {
  await upstream.close();
  await chrome.close();
  await vault.close();
});

async function opened(t) {
  const page = await chrome.page(t);
  await page.init(`() => {
    if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) {
      localStorage.setItem('slicc-os.vault-origin', ${JSON.stringify(vault.origin)});
      localStorage.setItem('slicc-os.users', 'enforce');
      globalThis.sliccKernelDebug = true;
    }
  }`);
  await page.goto('/');
  await page.within(
    120000,
    () => location.pathname === '/os/' && typeof globalThis.sliccKernelClient === 'function'
  );
  await page.within(
    60000,
    () => document.querySelector('slicc-app')?.model?.vault?.status()?.capabilities?.forward === 1
  );
  return page;
}

async function shell(page, command, env = {}) {
  return page.evaluate(
    async ({ command, env }) => {
      const client = await globalThis.sliccKernelClient();
      try {
        return await client.run(['bash', '-c', command], { cwd: '/', env });
      } finally {
        await client.close();
      }
    },
    { command, env }
  );
}

async function record(page, name, value, options = {}) {
  return page.evaluate(
    async ({ name, value, options }) =>
      document.querySelector('slicc-app').model.vault.put(name, value, undefined, options),
    { name, value, options }
  );
}

test('an ordinary Settings secret uses the real kernel and vault request path and returns scrubbed output', {
  timeout: 900000,
}, async (t) => {
  const page = await opened(t);
  const { placeholder } = await record(page, 'FORWARD_TOKEN', ORDINARY);
  const config = `default_provider = "seven"\n[providers.seven]\ntype = "sealed"\n[secrets]\nFORWARD_TOKEN = { provider = "seven", value = "${placeholder}" }\n[[proxy.rules]]\nsecret = "FORWARD_TOKEN"\ndomain = "forward.example.test"\nheader = "authorization"\nmethods = ["GET", "POST"]\npaths = ["/ordinary"]\n`;
  await page.evaluate(async (config) => {
    const client = await globalThis.sliccKernelClient();
    try {
      await client.fs.writeFile('/etc/fnox/config.toml', config);
    } finally {
      await client.close();
    }
  }, config);
  await page.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.vault.list()
      ?.secrets.some((item) => item.name === 'FORWARD_TOKEN' && item.rules?.length > 0)
  );
  const before = upstream.requests.length;
  const result = await shell(
    page,
    `curl -sS --fail-with-body -H "Authorization: Bearer $FORWARD_TOKEN" '${HOST}ordinary'`,
    { FORWARD_TOKEN: placeholder }
  );
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(placeholder));
  assert.equal(`${result.stdout}${result.stderr}`.includes(ORDINARY), false);
  const received = upstream.requests.slice(before);
  assert.equal(received.length, 1);
  assert.equal(bearer(received[0]), `Bearer ${ORDINARY}`);
  assert.equal(JSON.stringify(received).includes(placeholder), false);
  const refusedBefore = upstream.requests.length;
  const denied = await shell(
    page,
    `curl -sS --fail-with-body -H "Authorization: Bearer $FORWARD_TOKEN" '${HOST}wrong'`,
    { FORWARD_TOKEN: placeholder }
  );
  assert.notEqual(denied.status, 0);
  assert.equal(upstream.requests.length, refusedBefore);
});

test('a Settings MCP record supplies root mcpcat directly and scrubs the complete outgoing body', {
  timeout: 900000,
}, async (t) => {
  const page = await opened(t);
  const { placeholder } = await record(page, 'FORWARD_MCP', MCP, { kind: 'mcp', server: 'bb' });
  await record(page, 'BODY_VALUE', ORDINARY);
  await page.evaluate(
    (url) =>
      document
        .querySelector('slicc-app')
        .model.vault.endpoints({ add: { mcp: [{ server: 'bb', url }] } }),
    `${HOST}mcp`
  );
  await page.within(60000, () =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'mcpcat' && item.state === 'available')
  );
  assert.equal(await actPackage(page, 'mcpcat', 'install'), 'ok');
  const version = await shell(page, 'mcpcat --version');
  assert.match(`${version.stdout}${version.stderr}`, /0\.31\.15/);
  const added = await shell(
    page,
    `env -u PI_CODING_AGENT_DIR mcpcat add bb '${HOST}mcp' --no-probe`
  );
  assert.equal(added.status, 0);
  const before = upstream.requests.length;
  const info = await shell(page, 'env -u PI_CODING_AGENT_DIR mcpcat info bb');
  assert.equal(info.status, 0);
  assert.match(info.stdout, /Server: unit 1/);
  assert.match(info.stdout, /Tools: 0/);
  assert.equal(`${info.stdout}${info.stderr}`.includes(MCP), false);
  assert.equal(`${info.stdout}${info.stderr}`.includes(placeholder), false);
  assert.ok(upstream.requests.slice(before).length > 0);
  assert.ok(upstream.requests.slice(before).every((item) => bearer(item) === `Bearer ${MCP}`));
  const bodyBefore = upstream.requests.length;
  const body = await shell(
    page,
    `curl -sS --fail-with-body -H "Authorization: Bearer $FORWARD_MCP" -H 'Content-Type: application/json' --data-binary '${JSON.stringify({ value: ORDINARY })}' '${HOST}mcp/body'`,
    { FORWARD_MCP: placeholder }
  );
  assert.equal(body.status, 0);
  const sent = upstream.requests.slice(bodyBefore);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.includes(ORDINARY), false);
  assert.equal(bearer(sent[0]), `Bearer ${MCP}`);
  assert.equal(`${body.stdout}${body.stderr}`.includes(MCP), false);
  assert.equal(`${body.stdout}${body.stderr}`.includes(ORDINARY), false);
});
