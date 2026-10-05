import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, landed, ui, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('keeps serving the UI from OPFS after the network copy is gone', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  chrome.requests.length = 0;

  await page.reload();
  await landed(page);
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

test('lists everything in OPFS in the seed UI next to the page bash wrote', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await ui(page);

  const files = await page.evaluate(() =>
    [...document.querySelectorAll('#files li')].map((item) => item.textContent)
  );
  const expected = [
    /^bin\/bash[\d.]+kB$/,
    /^bin\/bash\.wasm[\d.]+MB$/,
    /^os\/bash\.html[\d.]+k?B$/,
    /^os\/index\.html[\d.]+k?B$/,
    /^os\/os\.css[\d.]+k?B$/,
    /^os\/os\.js[\d.]+k?B$/,
    /^var\/lib\/bios\/wasm-bash\.json\d+B$/,
  ];
  assert.equal(files.length, expected.length);
  for (const [i, pattern] of expected.entries()) assert.match(files[i], pattern);
  assert.deepEqual(page.errors, []);
});

test('shares one kernel between a tab on the UI and a tab booting', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await ui(page);

  const second = await page.tab();
  const bios = await watch(second);
  await boot(second);
  assert.match(bios.texts('kernel')[0], /^connection #[2-9]$/);
});
