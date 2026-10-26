import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { agentUp, boot, ready } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const MARK = 'AGENT-MCP-MARK';
const UNHELD = "SLICC couldn't protect the sign-in window. Try again.";
const certs = mkdtempSync(join(tmpdir(), 'slicc-agent-held-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=ims-na1.adobelogin.com',
    '-keyout',
    join(certs, 'key.pem'),
    '-out',
    join(certs, 'cert.pem'),
  ],
  { stdio: 'ignore' }
);
const authorized = [];
const idp = createHttps(
  { key: readFileSync(join(certs, 'key.pem')), cert: readFileSync(join(certs, 'cert.pem')) },
  (req, res) => {
    authorized.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Authorize the MCP server</title><h1>Authorize</h1>');
  }
);
await new Promise((resolve) => idp.listen(0, '127.0.0.1', resolve));
const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const chrome = await launch({
  tools: false,
  agent: true,
  timeout: 120000,
  args: [
    `--remote-debugging-port=${port}`,
    `--host-resolver-rules=MAP ims-na1.adobelogin.com:443 127.0.0.1:${idp.address().port}`,
    '--ignore-certificate-errors',
    '--disable-popup-blocking',
  ],
});
after(() => {
  chrome.close();
  idp.close();
  rmSync(certs, { recursive: true, force: true });
});
const fakeExtension = extensionOver(await debuggerUrl(port));
const devtools = (path) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json());

function debug() {
  globalThis.sliccKernelDebug = true;
}

async function agentLogin(page, path) {
  await page.evaluate(
    async ([path, MARK]) => {
      const at = new URL(
        '/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/spectrum/mcp-login.js',
        location.href
      );
      const { mcpLogin } = await import(at.href);
      window.mcpAbort = new AbortController();
      window.mcpAnswer = null;
      void mcpLogin()(
        'mcp:tracker',
        async () => ({
          url: `https://ims-na1.adobelogin.com/${path}?client_id=mcp#access_token=${MARK}-${path}`,
          state: `state-${path}`,
        }),
        { signal: window.mcpAbort.signal }
      ).then(
        () => {
          window.mcpAnswer = 'resolved';
        },
        (error) => {
          window.mcpAnswer = error.message ?? String(error);
        }
      );
    },
    [path, MARK]
  );
}

async function client(page, via) {
  await page.evaluate(async (via) => {
    const connection = await globalThis.sliccBrowserHook({ runtime: via });
    const pending = new Map();
    const events = [];
    let next = 0;
    connection.onmessage = (text) => {
      const message = JSON.parse(text);
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
        return;
      }
      events.push(text);
    };
    window.poller = {
      events,
      close: () => connection.close(),
      send: (method, params = {}) =>
        new Promise((resolve) => {
          next += 1;
          const id = next;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ error: { message: `${method} got no answer` } });
          }, 20000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          connection.send(JSON.stringify({ id, method, params }));
        }),
    };
  }, via);
  return {
    send: (method, params) => page.evaluate(([m, p]) => window.poller.send(m, p), [method, params]),
    seen: () => page.evaluate(() => window.poller.events.join('\n')),
    close: () => page.evaluate(() => window.poller.close()),
  };
}

async function heldThroughout(t, page, via) {
  const poller = await client(page, via);
  t.after(() => poller.close().catch(() => {}));
  await poller.send('Target.setDiscoverTargets', { discover: true });
  await poller.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  const before = new Set((await devtools('/json/list')).map((tab) => tab.id));
  const path = `authorize-${via}`;
  await agentLogin(page, path);
  const replies = [];
  const opened = new Set();
  const listed = new Set();
  const attached = new Set();
  let reached = false;
  for (let n = 0; n < 200 && !(reached && n > 40); n += 1) {
    for (const tab of await devtools('/json/list')) {
      if (before.has(tab.id) || tab.type !== 'page') continue;
      opened.add(tab.id);
      if (tab.url.includes(`/${path}`)) reached = true;
    }
    const listing = await poller.send('Target.getTargets');
    replies.push(JSON.stringify(listing));
    for (const info of listing.result?.targetInfos ?? []) listed.add(info.targetId);
    for (const targetId of opened) {
      const answer = await poller.send('Target.attachToTarget', { targetId, flatten: true });
      replies.push(JSON.stringify(answer));
      if (answer.result?.sessionId) attached.add(targetId);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(reached, 'the agent’s sign-in popup never reached the authorization page');
  assert.equal(await page.evaluate(() => window.mcpAnswer), null);
  for (const id of opened) {
    assert.ok(!listed.has(id), 'the agent’s sign-in popup was listed');
    assert.ok(!attached.has(id), 'the agent’s sign-in popup was attached');
  }
  const all = `${replies.join('\n')}\n${await poller.seen()}`;
  assert.ok(!all.includes(MARK), 'a message carried the popup’s URL fragment');
  await page.evaluate(() => window.mcpAbort.abort());
  await page.until(() => window.mcpAnswer !== null);
}

test('the agent’s real MCP sign-in popup is held through the marker on slicc-extension: a client polling and attaching throughout never lists it', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(debug);
  await boot(page, undefined, { tools: false });
  await agentUp(page);
  await heldThroughout(t, page, 'extension');
  assert.deepEqual(page.errors, []);
});

test('the agent’s real MCP sign-in popup is held through the marker on slicc-node: a client polling and attaching throughout never lists it', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(chrome.url).origin],
    cdp: `http://127.0.0.1:${port}`,
    kernelPort: null,
    log: () => {},
  });
  t.after(() => proxy.close());
  const page = await chrome.page(t);
  await page.init(debug);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(page, undefined, { tools: false });
  await agentUp(page);
  await page.until(
    () => document.querySelector('slicc-app').model.network.status().browser?.via === 'proxy'
  );
  await heldThroughout(t, page, 'proxy');
  assert.deepEqual(page.errors, []);
});

test('with no bios holder answering, the agent’s MCP sign-in fails and never opens the authorization page', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await page.init(debug);
  await boot(page, undefined, { tools: false });
  await agentUp(page);
  await page.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (data) {
      if (data?.type === 'hold') return;
      return post.call(this, data);
    };
  });
  const asked = authorized.length;
  await agentLogin(page, 'authorize-unheld');
  await page.within(60000, () => window.mcpAnswer !== null);
  assert.equal(await page.evaluate(() => window.mcpAnswer), UNHELD);
  assert.equal(authorized.length, asked, 'the authorization page was requested');
  assert.deepEqual(page.errors, []);
});
