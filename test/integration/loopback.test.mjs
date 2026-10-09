import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, ready, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const fixture = new URL('fixtures/httptest/', import.meta.url);

async function install(page) {
  const files = {
    'node_modules/httptest/package.json': (
      await readFile(new URL('package.json', fixture))
    ).toString('base64'),
    'node_modules/httptest/bin/httptest.wasm': (
      await readFile(new URL('bin/httptest.wasm', fixture))
    ).toString('base64'),
  };
  await page.evaluate(async (files) => {
    for (const [path, data] of Object.entries(files)) {
      const names = path.split('/');
      const name = names.pop();
      let dir = await navigator.storage.getDirectory();
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      await writable.close();
    }
  }, files);
}

test('reaches a kernel server as <port>.kernel.localhost, and plain localhost stays the machine', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await install(page);
  await page.reload();
  await ready(page);
  await run(page, 'httptest 8400 &');
  await shows(page, 'listening 8400');

  const script = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = 'http://8400.kernel.localhost/x.js';
        tag.onload = () => resolve(globalThis.fromKernel);
        tag.onerror = () => reject(new Error('script failed'));
        document.head.append(tag);
      })
  );
  assert.equal(script, 'hello from the kernel');

  const echoed = await page.evaluate(() =>
    fetch('http://8400.kernel.localhost/echo', { method: 'POST', body: 'posted' }).then(
      async (r) => [r.status, r.headers.get('x-served-from'), await r.text()]
    )
  );
  assert.deepEqual(echoed, [200, 'kernel', 'posted']);

  const events = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const seen = [];
        const source = new EventSource('http://8400.kernel.localhost/events');
        source.onmessage = ({ data }) => {
          seen.push(data);
          if (seen.length === 3) {
            source.close();
            resolve(seen);
          }
        };
        source.onerror = () => {
          if (seen.length < 3 && source.readyState === EventSource.CLOSED)
            reject(new Error('EventSource failed'));
        };
      })
  );
  assert.deepEqual(events, ['event 1', 'event 2', 'event 3']);

  const refused = await page.evaluate(() =>
    fetch('http://8401.kernel.localhost/x.js').then(async (r) => [r.status, await r.text()])
  );
  assert.deepEqual(refused, [502, 'sw: nothing listening on kernel port 8401\n']);

  const plain = await page.evaluate(() =>
    fetch('http://localhost:8400/x.js').then(
      async (r) => [r.status, r.headers.get('x-served-from')],
      (error) => error.name
    )
  );
  assert.equal(plain, 'TypeError');
});
