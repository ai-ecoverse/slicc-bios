import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { ready } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const debugging = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const chrome = await launch({ args: [`--remote-debugging-port=${debugging}`] });
after(() => chrome.close());
const fakeExtension = extensionOver(await debuggerUrl(debugging));

async function rig({ transport, proxy }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { proxyHost, extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const raw =
    transport === 'proxy'
      ? await proxyHost(proxy)()
      : extensionConnection(globalThis.sliccExtension.cdp);
  const connection = guardProtected(raw, self.origin);
  const pending = new Map();
  const events = [];
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id === undefined) events.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  window.rig = {
    events,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        next += 1;
        const id = next;
        const timer = setTimeout(
          () => resolve({ error: { message: `${method} got no answer` } }),
          10000
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      }),
  };
}

async function churn(t, transport, rounds) {
  const page = await chrome.page(t);
  let proxy;
  if (transport === 'proxy') {
    proxy = await startProxy({
      port: 0,
      origins: [new URL(chrome.url).origin],
      cdp: `http://127.0.0.1:${debugging}`,
      kernelPort: null,
      log: () => {},
    });
    t.after(() => proxy.close());
  } else {
    const extension = await fakeExtension(page);
    t.after(() => extension.close());
  }
  await page.goto(proxy ? `/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}` : '/');
  await ready(page);
  await page.evaluate(rig, { transport, proxy: proxy && { url: proxy.url, key: proxy.key } });
  chrome.overrides.set(
    '/spawn.html',
    '<!doctype html><script>window.w = new SharedWorker("/spawned.js?" + Math.random(), "spawned-" + Math.random());</script>'
  );
  chrome.overrides.set('/spawned.js', 'onconnect = (e) => e.ports[0].postMessage("hi");');
  const auto = (on) =>
    page.evaluate(
      (on) =>
        window.rig.send('Target.setAutoAttach', {
          autoAttach: on,
          waitForDebuggerOnStart: on,
          flatten: true,
        }),
      on
    );
  for (let round = 0; round < rounds; round += 1) {
    await auto(true);
    const { targetId } = await chrome.cdp.send('Target.createTarget', {
      url: new URL('/spawn.html', chrome.url).href,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await auto(false);
    const up = await Promise.race([
      chrome.cdp.send('Browser.getVersion').then(
        () => true,
        () => false
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    assert.equal(up, true, `the browser is gone after round ${round}`);
  }
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector('slicc-app'))),
    true,
    'seven is still up'
  );
  const workers = await page.evaluate(() =>
    window.rig.events
      .filter((event) => event.method === 'Target.attachedToTarget')
      .map((event) => event.params.targetInfo.type)
  );
  assert.ok(
    !workers.some((type) => type === 'shared_worker' || type === 'service_worker'),
    JSON.stringify(workers)
  );
}

test(
  'a paused browser-level auto-attach toggled while seven’s shared workers come and go leaves the browser and seven up, on the proxy path',
  { timeout: 5 * 60 * 1000 },
  (t) => churn(t, 'proxy', 30)
);

test(
  'a paused browser-level auto-attach toggled while seven’s shared workers come and go leaves the browser and seven up, on the extension path',
  { timeout: 5 * 60 * 1000 },
  (t) => churn(t, 'extension', 30)
);
