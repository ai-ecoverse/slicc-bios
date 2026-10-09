import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const chrome = await launch({ args: [`--remote-debugging-port=${port}`] });
after(() => chrome.close());
const browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
  .webSocketDebuggerUrl;

async function fakeExtension(page) {
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const sent = [];
  socket.onmessage = ({ data }) =>
    void page.evaluate((message) => window.cdpIn(message), data).catch(() => false);
  await page.expose('cdpOut', (command) => {
    sent.push(command.method);
    socket.send(JSON.stringify(command));
  });
  await page.init(() => {
    const pending = new Map();
    const listeners = new Set();
    let next = 0;
    window.cdpIn = (text) => {
      const message = JSON.parse(text);
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
    };
    Object.defineProperty(globalThis, 'sliccExtension', {
      value: Object.freeze({
        fetch: (input, init) => fetch(input, init),
        cdp: Object.freeze({
          send(method, params, sessionId) {
            const id = ++next;
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              window.cdpOut(JSON.stringify({ id, method, params, sessionId }));
            });
          },
          on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        }),
      }),
    });
  });
  return { sent, close: () => socket.close() };
}

test('playwright-cli drives a page through slicc-extension, and the page cannot reach 9222', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/driven.html',
    '<!doctype html><title>driven</title><h1>Driven from the kernel</h1>'
  );
  const target = new URL('/driven.html', chrome.url).href;

  await run(
    page,
    `curl -sf http://127.0.0.1:9222/json/list | jq -r '.[] | select(.url | endswith("/os/")) | "listed as " + .type'`
  );
  await shows(page, 'listed as page');

  await run(
    page,
    `playwright-cli open about:blank && playwright-cli goto ${target} && playwright-cli snapshot`
  );
  await shows(page, 'heading "Driven from the kernel"');
  const driven = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.ok(driven.some(({ url }) => url === target));
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');

  for (const method of ['Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate']) {
    assert.ok(extension.sent.includes(method), `${method} went to the extension`);
  }

  const refused = await page.evaluate(() =>
    fetch('http://9222.kernel.localhost/json/version').then(async (r) => [r.status, await r.text()])
  );
  assert.deepEqual(refused, [502, 'sw: nothing listening on kernel port 9222\n']);
  assert.deepEqual(page.errors, []);
});

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/').filter(Boolean);
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test('with no host, the CDP endpoint says what to install', async (t) => {
  const page = await chrome.page(t);
  await boot(page);

  await run(
    page,
    `curl -s -w '%{http_code}' http://127.0.0.1:9222/json/list > /tmp/none; curl -s -w '%{http_code}' 'http://127.0.0.1:9222/json/list?runtime=elsewhere' > /tmp/elsewhere; echo done-$?`
  );
  await shows(page, 'done-0');
  assert.equal(
    await read(page, '/tmp/none'),
    'CDP host: no browser to drive: install slicc-extension, or run npx @ai-ecoverse/slicc-node\n502'
  );
  assert.equal(
    await read(page, '/tmp/elsewhere'),
    'CDP host: unknown runtime "elsewhere" (extension, proxy)\n502'
  );
});
