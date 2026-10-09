import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ServerResponse } from 'node:http';
import { after, test } from 'node:test';
import { boot, ready, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
const held = [];
const end = ServerResponse.prototype.end;
ServerResponse.prototype.end = function (chunk, ...rest) {
  if (!this.req?.url?.startsWith('/never/')) return end.call(this, chunk, ...rest);
  if (chunk) this.write(chunk);
  held.push(() => end.call(this));
  return this;
};
after(async () => {
  ServerResponse.prototype.end = end;
  for (const release of held) release();
  await chrome.close();
});

test('keeps serving the UI from OPFS after the network copy is gone', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  chrome.requests.length = 0;

  await page.reload();
  await ready(page);
  assert.deepEqual(
    chrome.requests.filter((path) => /^\/(os|node_modules)\//.test(path)),
    []
  );
  assert.equal(await page.evaluate(() => fetch('../bios.css').then((r) => r.status)), 200);
  assert.ok(chrome.requests.includes('/bios.css'));
  const bash = await page.evaluate(() =>
    fetch('../node_modules/@ai-ecoverse/wasm-bash/bin/bash').then((r) => [
      r.headers.get('content-type'),
      r.headers.get('x-served-from'),
    ])
  );
  assert.deepEqual(bash, ['application/octet-stream', 'opfs']);
  assert.ok(!chrome.requests.some((path) => path.startsWith('/node_modules/')));
});

test('shares one installer between tabs', async (t) => {
  const page = await chrome.page(t);
  await boot(page);

  const second = await page.tab();
  const bios = await watch(second);
  await boot(second);
  assert.match(bios.texts('installer')[0], /^connection #[2-9]$/);
});

test('answers with a 504 that names the path when the network never answers, and ends a body that stops', async (t) => {
  const page = await chrome.page(t);
  const sw = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
  chrome.overrides.set('/sw.js', sw.replace('const PATIENCE = 30000;', 'const PATIENCE = 10000;'));
  t.after(() => chrome.overrides.delete('/sw.js'));
  await boot(page);
  chrome.overrides.set('/never/partial.js', 'export const half = 1;\n');

  const answer = await page.evaluate(() =>
    fetch('/never/answered.js').then(async (r) => [r.status, await r.text()])
  );
  assert.deepEqual(answer, [504, 'sw: no answer for /never/answered.js in 10 s\n']);
  assert.ok(chrome.requests.includes('/never/answered.js'));

  const partial = await page.evaluate(() =>
    fetch('/never/partial.js').then((r) =>
      r.text().then(
        () => [r.status, 'complete'],
        (error) => [r.status, error.name]
      )
    )
  );
  assert.deepEqual(partial, [200, 'TypeError']);
});
