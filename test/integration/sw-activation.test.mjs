import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
const HOLD = 5000;
const SIZE = 64 * 1024 * 1024;
let bump = 0;

async function updateWhileHolding(page, url) {
  bump += 1;
  chrome.overrides.set(
    '/sw.js',
    current.replace('const own = ', `const own =${' '.repeat(bump)} `)
  );
  return page.evaluate(
    async ([url, hold]) => {
      const start = performance.now();
      const at = () => Math.round(performance.now() - start);
      const log = [];
      const response = await fetch(url);
      const reader = response.body.getReader();
      log.push(
        `${at()} ${url} ${response.status}, read ${(await reader.read()).value?.byteLength}`
      );
      const registration = await navigator.serviceWorker.getRegistration();
      await registration.update();
      const worker = registration.installing ?? registration.waiting;
      if (!worker) return { log: [...log, 'no new worker'], held: null, released: null };
      worker.addEventListener('statechange', () => log.push(`${at()} ${worker.state}`));
      const until = async (ms) => {
        const end = performance.now() + ms;
        while (worker.state !== 'activated' && performance.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 50));
      };
      await until(hold);
      const held = worker.state;
      await reader.cancel();
      log.push(`${at()} cancelled`);
      await until(hold);
      return { log, held, released: worker.state };
    },
    [url, HOLD]
  );
}

test('Chrome keeps an updated worker installed while a page holds a half-read streamed response from the old one, activates it once the page cancels, and a blob body holds nothing (#699)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  const streamed = await updateWhileHolding(page, '/os/held.bin');
  assert.deepEqual(
    [streamed.held, streamed.released],
    ['installed', 'activated'],
    streamed.log.join('\n')
  );
  await page.evaluate(async (size) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home', {
      create: true,
    });
    const writable = await (
      await home.getFileHandle('held.bin', { create: true })
    ).createWritable();
    await writable.write(new Uint8Array(size));
    await writable.close();
  }, SIZE);
  const blob = await updateWhileHolding(page, '/home/held.bin');
  assert.equal(blob.held, 'activated', blob.log.join('\n'));
  assert.deepEqual(page.errors, []);
});
