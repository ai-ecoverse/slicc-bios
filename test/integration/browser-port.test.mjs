import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { devtools as boundPort, debuggerUrl, launch } from './chrome.mjs';

const chrome = await launch({ args: ['--remote-allow-origins=*'] });
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
