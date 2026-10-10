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

const automation = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.network.status().browser);

const open = (page) =>
  page.evaluate(() =>
    Boolean(document.querySelector('slicc-app').shadowRoot.querySelector('slicc-confirm'))
  );

test('playwright-cli drives a page through slicc-extension without asking, and the page cannot reach 9222', async (t) => {
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
  assert.deepEqual(await automation(page), { via: 'extension' });
  assert.equal(await open(page), false);
  await page.evaluate(() =>
    document.querySelector('slicc-app').shadowRoot.querySelector('[data-network]').click()
  );
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .dock.content('network')
        ?.shadowRoot?.textContent.includes('Browser automation: through the SLICC extension.') ??
      false
  );
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'light') app.toggleColor();
  });
  await page.screenshot(new URL('network-browser-light.png', page.dir));

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

test('the browser port lists only the tabs the agent drives, holds them for a while, and shows them', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/port.html',
    '<!doctype html><title>Tide tables</title><h1 style="font-size:96px">Tide tables</h1>'
  );
  const target = new URL('/port.html', chrome.url).href;
  const foreign = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  t.after(() => fetch(`http://127.0.0.1:${port}/json/close/${foreign.id}`));

  await run(page, `playwright-cli open ${target} && echo opened-$?`);
  await shows(page, 'opened-0');
  const tabs = await page.until(() => {
    const tabs = document.querySelector('slicc-app').model.browser.list();
    return tabs.length > 0 && tabs.every(({ title }) => title) && tabs;
  });
  assert.deepEqual(
    tabs.map(({ url, title, agentId }) => [url, title, agentId]),
    [[target, 'Tide tables', null]]
  );
  assert.equal(tabs[0].controlled, true);
  const shot = await page.evaluate(
    (id) => document.querySelector('slicc-app').model.browser.screenshot(id),
    tabs[0].id
  );
  assert.match(shot, /^data:image\/jpeg;base64,\/9j\//);
  const refused = await page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.browser.screenshot(id)
        .then(
          () => 'shown',
          (error) => error.message
        ),
    foreign.id
  );
  assert.equal(refused, `not a tab SLICC is using: ${foreign.id}`);
  await page.within(
    20000,
    () => document.querySelector('slicc-app').model.browser.list()[0]?.controlled === false
  );
  assert.ok(extension.sent.includes('Page.captureScreenshot'));
  assert.ok(extension.sent.includes('Target.detachFromTarget'));
  assert.equal(extension.sent.filter((method) => method.startsWith('Slicc.')).length, 0);

  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
  await page.until(() => document.querySelector('slicc-app').model.browser.list().length === 0);
  assert.deepEqual(page.errors, []);
});

test('playwright-cli’s reports become private action rows, and Stop closes the agent’s connection', async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  chrome.overrides.set(
    '/form.html',
    '<!doctype html><title>Tide form</title><input aria-label="Port"><button>Show forecast</button>'
  );
  const target = new URL('/form.html', chrome.url).href;
  await page.evaluate(() => {
    window.rows = [];
    document
      .querySelector('slicc-app')
      .model.browser.on('action', (row) => window.rows.push(JSON.stringify(row)));
  });
  const agent = 'SLICC_AGENT=cone:harbor';
  await run(
    page,
    `${agent} playwright-cli open '${target}?q=QUERYSECRET#FRAGSECRET' && ${agent} playwright-cli snapshot > /tmp/snap && ref=$(grep -o 'textbox "Port" \\[ref=[a-z0-9]*' /tmp/snap | sed 's/.*ref=//') && ${agent} playwright-cli fill $ref secret-text && ${agent} playwright-cli eval 'document.title + "-hidden-source"' && { ${agent} playwright-cli eval 'throw new Error("EVALSECRET")'; echo acted-$?; }`
  );
  await shows(page, 'acted-1');
  const rows = await page.until(() => {
    const rows = document.querySelector('slicc-app').model.browser.actions();
    return rows.length >= 5 && rows.every(({ status }) => status !== 'running') && rows;
  });
  assert.deepEqual(
    rows.map(({ kind, status, agentId }) => [kind, status, agentId]),
    [
      ['open', 'done', 'harbor'],
      ['snapshot', 'done', 'harbor'],
      ['fill', 'done', 'harbor'],
      ['eval', 'done', 'harbor'],
      ['eval', 'failed', 'harbor'],
    ]
  );
  assert.equal('error' in rows[4], false);
  const [opened, , filled] = rows;
  assert.equal(opened.value, target);
  assert.equal(filled.target, 'textbox "Port"');
  assert.equal(filled.length, 11);
  const everything = JSON.stringify([rows, await page.evaluate(() => window.rows)]);
  assert.equal(everything.includes('secret-text'), false);
  for (const secret of ['hidden-source', 'QUERYSECRET', 'FRAGSECRET', 'EVALSECRET']) {
    assert.equal(everything.includes(secret), false, secret);
  }
  const tabs = await page.evaluate(() => document.querySelector('slicc-app').model.browser.list());
  assert.deepEqual(
    tabs.map(({ id, agentId }) => [id, agentId]),
    [[opened.tabId, 'harbor']]
  );
  await run(
    page,
    `${agent} playwright-cli goto 'data:text/html,<p>DATASECRET</p>' > /dev/null 2>&1; ${agent} playwright-cli goto 'javascript:void("JSSECRET")' > /dev/null 2>&1; ${agent} playwright-cli goto 'host:8080/HOSTSECRET' > /dev/null 2>&1; ${agent} playwright-cli goto 'user:USERSECRET@host/x' > /dev/null 2>&1; echo opaque-done`
  );
  await shows(page, 'opaque-done');
  const opaque = await page.until(() => {
    const gone = document
      .querySelector('slicc-app')
      .model.browser.actions()
      .filter(({ kind }) => kind === 'goto');
    return gone.length === 4 && gone.every(({ status }) => status !== 'running') && gone;
  });
  assert.deepEqual(
    opaque.map(({ value }) => value),
    ['data:', 'javascript:', undefined, undefined]
  );
  const later = JSON.stringify([
    await page.evaluate(() => document.querySelector('slicc-app').model.browser.actions()),
    await page.evaluate(() => window.rows),
  ]);
  for (const secret of ['DATASECRET', 'JSSECRET', 'HOSTSECRET', 'USERSECRET']) {
    assert.equal(later.includes(secret), false, secret);
  }
  assert.equal(extension.sent.filter((method) => method.startsWith('Slicc.')).length, 0);

  const cone = 'cone';
  await run(
    page,
    `SLICC_AGENT=cone:${cone} playwright-cli eval 'new Promise(() => {})' > /tmp/held 2>&1; echo "held-$?"`
  );
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.browser.actions()
      .some(({ kind, status }) => kind === 'eval' && status === 'running')
  );
  await page.evaluate((cone) => document.querySelector('slicc-app').model.agent.stop(cone), cone);
  await shows(page, 'held-1');
  const stopped = await page.evaluate(() =>
    document.querySelector('slicc-app').model.browser.actions().at(-1)
  );
  assert.deepEqual([stopped.kind, stopped.status, stopped.error], ['eval', 'failed', 'Stopped']);
  await run(page, 'playwright-cli close && echo closed-$?');
  await shows(page, 'closed-0');
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
  await shows(second, 'second-200');
  await first.send('Page.bringToFront');
  await shows(first, 'held-1');
  assert.equal(
    await read(first, '/tmp/held'),
    'websocket closed 1011 another page took over the local proxy’s browser connection (superseded-by-new-cdp-client)\n'
  );
});
