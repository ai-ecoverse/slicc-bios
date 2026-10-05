import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, booted, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const downloaded = /^bin\/bash, bin\/bash\.wasm 5\.\dMB$/;

async function reboot(page) {
  chrome.cdn.requests.length = 0;
  const bios = await watch(page);
  await boot(page);
  assert.deepEqual(bios.states(), booted);
  assert.deepEqual(bios.texts('script'), ['wrote os/bash.html after seeing 4 files in os/']);
  return bios.texts('bash').at(-1);
}

test('reuses the bash already in OPFS on reboot', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.equal(chrome.cdn.requests.length, 2);

  assert.match(await reboot(page), /^bin\/bash, bin\/bash\.wasm 5\.\dMB, already in OPFS$/);
  assert.deepEqual(chrome.cdn.requests, []);
});

test('downloads bash again when a file in OPFS is missing', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate(async () => {
    const bin = await (await navigator.storage.getDirectory()).getDirectoryHandle('bin');
    await bin.removeEntry('bash.wasm');
  });

  assert.match(await reboot(page), downloaded);
  assert.equal(chrome.cdn.requests.length, 2);
});

test('downloads bash again when the receipt is for another version', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const name of ['var', 'lib', 'bios']) dir = await dir.getDirectoryHandle(name);
    const receipt = await (await dir.getFileHandle('wasm-bash.json')).createWritable();
    const from = 'https://cdn.jsdelivr.net/npm/@ai-ecoverse/wasm-bash@5.3.0-6/';
    await receipt.write(JSON.stringify({ from, bytes: 5506574 }));
    await receipt.close();
  });

  assert.match(await reboot(page), downloaded);
  assert.equal(chrome.cdn.requests.length, 2);
});
