import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { boot, ready, run, shows } from './bios.mjs';
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

function asked(page) {
  return page.until(() => {
    const dialog = document
      .querySelector('slicc-app')
      ?.shadowRoot?.querySelector('slicc-confirm')
      ?.renderRoot?.querySelector('dialog[open]');
    if (!dialog) return null;
    const action = dialog.querySelector('[data-action]');
    return {
      title: dialog.querySelector('#title').textContent,
      body: dialog.querySelector('#body').textContent,
      action: action.textContent.trim(),
      cancel: dialog.querySelector('[data-cancel]').textContent.trim(),
      variant: action.getAttribute('variant'),
    };
  });
}

function answer(page, button) {
  return page.evaluate((button) => {
    document
      .querySelector('slicc-app')
      .shadowRoot.querySelector('slicc-confirm')
      .renderRoot.querySelector(`[data-${button}]`)
      .click();
  }, button);
}

const automation = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.network.status().browser);

const open = (page) =>
  page.evaluate(() =>
    Boolean(document.querySelector('slicc-app').shadowRoot.querySelector('slicc-confirm'))
  );

test('playwright-cli drives a page through slicc-extension once allowed, and the page cannot reach 9222', async (t) => {
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
  assert.deepEqual(await asked(page), {
    title: 'Let SLICC’s agents control this browser?',
    body: 'They can open tabs, click and type with your logins. This lasts until you reload.',
    action: 'Allow',
    cancel: 'Don’t allow',
    variant: 'accent',
  });
  await answer(page, 'action');
  await shows(page, 'listed as page');
  assert.deepEqual(await automation(page), { via: 'extension' });
  assert.equal(await open(page), false);

  await run(
    page,
    `playwright-cli open about:blank && playwright-cli goto ${target} && playwright-cli snapshot`
  );
  await shows(page, 'heading "Driven from the kernel"');
  const driven = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.ok(driven.some(({ url }) => url === target));
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  await run(page, `curlwright http://foreign.test/ > /tmp/curlwright 2>&1; echo "curlwright-$?"`);
  await shows(page, 'curlwright-2');
  assert.match(await read(page, '/tmp/curlwright'), /--tab/);
  assert.equal(await open(page), false);

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
  assert.deepEqual(await automation(page), { via: null });
});

test('declining browser control answers 502 until the page reloads', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  const declined = 'CDP host: browser control was declined in seven; reload to be asked again\n502';

  await run(
    page,
    `curl -s -w '%{http_code}' http://127.0.0.1:9222/json/list > /tmp/first; echo first-$?`
  );
  await asked(page);
  await answer(page, 'cancel');
  await shows(page, 'first-0');
  assert.equal(await read(page, '/tmp/first'), declined);

  await run(
    page,
    `playwright-cli tab-list; curl -s -w '%{http_code}' http://127.0.0.1:9222/json/list > /tmp/again; echo again-$?`
  );
  await shows(page, 'again-0');
  assert.equal(await open(page), false);
  assert.equal(await read(page, '/tmp/again'), declined);
  assert.deepEqual(await automation(page), {
    via: 'extension',
    declined: true,
  });
  assert.deepEqual(extension.sent, []);
});

async function viaProxy(t) {
  const proxy = await startProxy({
    port: 0,
    origins: [new URL(chrome.url).origin],
    cdp: `http://127.0.0.1:${port}`,
    kernelPort: null,
    log: () => {},
  });
  t.after(() => proxy.close());
  return proxy;
}

async function launched(t, proxy) {
  const page = await chrome.page(t);
  await page.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(page);
  return page;
}

test('playwright-cli drives a page through slicc-node’s /cdp, on one shared socket', async (t) => {
  const proxy = await viaProxy(t);
  const page = await launched(t, proxy);
  assert.deepEqual(await automation(page), { via: 'proxy' });
  chrome.overrides.set(
    '/driven.html',
    '<!doctype html><title>driven</title><h1>Driven through slicc-node</h1>'
  );
  const target = new URL('/driven.html', chrome.url).href;

  await run(
    page,
    `curl -sf http://127.0.0.1:9222/json/list | jq -r '.[] | select(.url | endswith("/os/")) | "listed as " + .type'`
  );
  await asked(page);
  await answer(page, 'action');
  await shows(page, 'listed as page');

  await run(
    page,
    `playwright-cli open about:blank && playwright-cli goto ${target} && playwright-cli snapshot`
  );
  await shows(page, 'heading "Driven through slicc-node"');
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  assert.equal(await open(page), false);
  assert.deepEqual(page.errors, []);
});

test('when another page takes over slicc-node’s /cdp, the first page’s connections close and say so', async (t) => {
  const proxy = await viaProxy(t);
  const first = await launched(t, proxy);
  await run(first, 'playwright-cli open about:blank');
  await asked(first);
  await answer(first, 'action');
  await shows(first, 'Opened about:blank');
  await run(first, `playwright-cli eval 'new Promise(() => {})' > /tmp/held 2>&1; echo "held-$?"`);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const second = await first.tab();
  await second.goto(`/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}`);
  await ready(second);
  await run(
    second,
    `curl -s -o /dev/null -w 'second-%{http_code}' http://127.0.0.1:9222/json/list`
  );
  await asked(second);
  await answer(second, 'action');
  await shows(second, 'second-200');
  await first.send('Page.bringToFront');
  await shows(first, 'held-1');
  assert.equal(
    await read(first, '/tmp/held'),
    'websocket closed 1011 another page took over the local proxy’s browser connection (superseded-by-new-cdp-client)\n'
  );
});
