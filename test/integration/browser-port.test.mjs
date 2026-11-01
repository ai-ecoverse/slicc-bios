import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { devtools as boundPort, debuggerUrl, launch } from './chrome.mjs';

const chrome = await launch({
  args: ['--remote-allow-origins=*', '--host-resolver-rules=MAP *.frame.test 127.0.0.1'],
});
const { port } = await boundPort(chrome);
const browser = await debuggerUrl(port);
after(() => chrome.close());

const elsewhere = (path) => {
  const at = new URL(path, chrome.url);
  at.hostname = 'localhost';
  return at.href;
};
const automation = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.network.status().browser);
const define = (url) => `Object.defineProperty(globalThis, 'crestDevTools', {
  configurable: true,
  value: Object.freeze({ webSocketDebuggerUrl: ${JSON.stringify(url)} }),
});`;

test('a browser that offers its own DevTools port is driven through the guard, and seven stays out of reach', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: define(browser) });
  await boot(page);
  chrome.overrides.set(
    '/driven.html',
    '<!doctype html><title>driven</title><h1>Driven through the port</h1>'
  );
  assert.deepEqual(await automation(page), { via: 'devtools' });
  await run(
    page,
    `curl -sf http://127.0.0.1:9222/json/list | jq -r '[.[] | select(.url | endswith("/os/"))] | "seven listed " + (length | tostring)'`
  );
  await shows(page, 'seven listed 0');
  await run(
    page,
    `playwright-cli --runtime devtools open about:blank && playwright-cli --runtime devtools goto ${elsewhere('/driven.html')} && playwright-cli --runtime devtools snapshot`
  );
  await shows(page, 'heading "Driven through the port"');
  await run(page, `playwright-cli --runtime devtools goto ${chrome.url}os/; echo refused-$?`);
  await shows(page, 'refused-1');
  await run(page, 'playwright-cli --runtime devtools eval location.href');
  await shows(page, elsewhere('/driven.html'));
});

test('a DevTools port that arrives late is picked up when the browser announces it', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.deepEqual(await automation(page), { via: null });
  await page.evaluate((url) => {
    Object.defineProperty(globalThis, 'crestDevTools', {
      configurable: true,
      value: Object.freeze({ webSocketDebuggerUrl: url }),
    });
    dispatchEvent(new Event('crestdevtools'));
  }, browser);
  assert.deepEqual(await automation(page), { via: 'devtools' });
  await run(page, 'curl -sf http://127.0.0.1:9222/json/list | jq -r "length > 0"');
  await shows(page, 'true');
});

const holding = (url) => `(() => {
  const Real = globalThis.WebSocket;
  globalThis.WebSocket = class extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(at, protocols) {
      super();
      if (at !== ${JSON.stringify(url)}) return new Real(at, protocols);
      const asked = new Map();
      this.asked = asked;
      this.real = new Real(at);
      this.real.onopen = (event) => this.onopen?.(event);
      this.real.onerror = (event) => this.onerror?.(event);
      this.real.onclose = (event) => this.onclose?.(event);
      const crestLike = (node) => {
        if (!node) return;
        delete node.contentDocument;
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])])
          crestLike(child);
      };
      this.real.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        const method = asked.get(message.id);
        asked.delete(message.id);
        if (method === 'Fetch.enable' && message.result) message.result.holdsDocuments = true;
        if (method === 'DOM.getDocument') crestLike(message.result?.root);
        this.onmessage?.({ data: method ? JSON.stringify(message) : data });
      };
    }
    send(text) {
      const { id, method, sessionId } = JSON.parse(text);
      if (method === 'Target.setAutoAttach' && sessionId) {
        const error = { code: -32601, message: "'Target.setAutoAttach' wasn't found" };
        queueMicrotask(() =>
          this.onmessage?.({ data: JSON.stringify({ id, sessionId, error }) })
        );
        return;
      }
      if (method === 'Fetch.enable' || method === 'DOM.getDocument') this.asked.set(id, method);
      this.real.send(text);
    }
    close() {
      this.real.close();
    }
  };
})();`;

test('a browser that attests holdsDocuments paints past a listed frame, takes input, and refuses once the frame moves to seven', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: define(browser) });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: holding(browser) });
  await boot(page);
  const framed = new URL('/framed-inner.html', chrome.url);
  framed.hostname = 'inner.frame.test';
  const outer = new URL('/framed-outer.html', chrome.url);
  outer.hostname = 'outer.frame.test';
  chrome.overrides.set('/framed-inner.html', '<!doctype html><title>inner</title><h2>Inner</h2>');
  chrome.overrides.set(
    '/framed-outer.html',
    `<!doctype html><title>outer</title><h1>Outer</h1><iframe src="${framed.href}"></iframe><iframe></iframe>`
  );
  await run(
    page,
    `playwright-cli --runtime devtools open about:blank && playwright-cli --runtime devtools goto ${outer.href} && playwright-cli --runtime devtools screenshot --filename=/tmp/framed.png; echo painted-$?`
  );
  await shows(page, 'painted-0');
  await run(page, 'playwright-cli --runtime devtools press Tab; echo pressed-$?');
  await shows(page, 'pressed-0');
  await run(
    page,
    `playwright-cli --runtime devtools eval "document.querySelector('iframe').src = '${chrome.url}os/'; 1"; sleep 2; playwright-cli --runtime devtools screenshot --filename=/tmp/moved.png; echo moved-$?`
  );
  await shows(page, 'moved-1');
});
