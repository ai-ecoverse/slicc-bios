import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, booted, ready, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('keeps serving the UI from OPFS after the network copy is gone', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  chrome.requests.length = 0;

  await page.reload();
  await ready(page);
  assert.deepEqual(
    chrome.requests.filter((path) => /^\/(os|bin)\//.test(path)),
    []
  );
  assert.equal(await page.evaluate(() => fetch('../bios.css').then((r) => r.status)), 200);
  assert.ok(chrome.requests.includes('/bios.css'));
  const bash = await page.evaluate(() =>
    fetch('../bin/bash').then((r) => [
      r.headers.get('content-type'),
      r.headers.get('x-served-from'),
    ])
  );
  assert.deepEqual(bash, ['application/octet-stream', 'opfs']);
  assert.ok(!chrome.requests.includes('/bin/bash'));
});

test('reboots over an existing installation', async (t) => {
  const page = await chrome.page(t);
  await boot(page);

  const bios = await watch(page);
  await boot(page);
  assert.deepEqual(bios.states(), booted);
});

test('shares one kernel between tabs', async (t) => {
  const page = await chrome.page(t);
  await boot(page);

  const second = await page.tab();
  const bios = await watch(second);
  await boot(second);
  assert.match(bios.texts('kernel')[0], /^connection #[2-9]$/);
});
