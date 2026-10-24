import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { pausedWorkers } from './sw-resume.mjs';

const chrome = await launch();
after(() => chrome.close());

const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
const HOLD = 5000;
const SIZE = 64 * 1024 * 1024;
let bump = 0;

async function updateWhileHolding(page, url, release) {
  bump += 1;
  chrome.overrides.set(
    '/sw.js',
    current.replace('const own = ', `const own =${' '.repeat(bump)} `)
  );
  await page.evaluate(async (url) => {
    const start = performance.now();
    const response = await fetch(url);
    const reader = response.body.getReader();
    window.heldRead = {
      start,
      url,
      status: response.status,
      bytes: (await reader.read()).value?.byteLength,
      reader,
    };
  }, url);
  const resumed = await release();
  const streamed = await page.evaluate(async (hold) => {
    const { start, url, status, bytes, reader } = window.heldRead;
    const at = () => Math.round(performance.now() - start);
    const log = [`${at()} ${url} ${status}, read ${bytes}`];
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
  }, HOLD);
  return { ...streamed, resumed };
}

test('Chrome keeps an updated worker installed while a page holds a half-read streamed response from the old one, activates it once the page cancels, and a blob body holds nothing (#699)', async (t) => {
  const page = await chrome.page(t);
  const workers = pausedWorkers(chrome);
  t.after(workers.stop);
  await boot(page);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  const streamed = await updateWhileHolding(page, '/os/held.bin', () => workers.release());
  console.log(`sw-activation streamed ${JSON.stringify(streamed.resumed)}`);
  assert.deepEqual(
    [streamed.held, streamed.released],
    ['installed', 'activated'],
    `${streamed.log.join('\n')}\n${JSON.stringify(streamed.resumed)}`
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
  const blob = await updateWhileHolding(page, '/home/held.bin', () => workers.release());
  console.log(`sw-activation blob ${JSON.stringify(blob.resumed)}`);
  assert.equal(blob.held, 'activated', `${blob.log.join('\n')}\n${JSON.stringify(blob.resumed)}`);
  assert.deepEqual(page.errors, []);
});
