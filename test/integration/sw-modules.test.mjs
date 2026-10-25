import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, booted, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const source = (path) => readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const stubs = await source('sw/stubs.js');
const integrity = await source('sw/integrity.js');
const MISSING = 'is not available in the browser';

const probed = (n) => stubs.replace(MISSING, `${MISSING}, probe ${n}`);

const served = (page) =>
  page.evaluate(async () => {
    const stub = await (await fetch('/__slicc/node/fs.js')).text();
    const { pathname } = new URL(navigator.serviceWorker.controller.scriptURL);
    return { worker: pathname, probe: stub.match(/probe \d+/)?.[0] ?? null };
  });

async function release(page, changes) {
  for (const [path, body] of Object.entries(changes)) chrome.overrides.set(path, body);
  const bios = await watch(page);
  const mark = page.responses.length;
  await boot(page);
  const refused = page.responses
    .slice(mark)
    .filter((response) => response.status >= 400)
    .map((response) => `${response.status} ${new URL(response.url).pathname}`);
  assert.deepEqual(refused, []);
  assert.deepEqual(bios.states(), booted);
  return served(page);
}

test('a release that changes only a module sw.js imports updates an installed seven, and so does the next one (#1022)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.deepEqual(await served(page), { worker: '/sw.js', probe: null });
  assert.deepEqual(await release(page, { '/sw/stubs.js': probed(1) }), {
    worker: '/sw.js',
    probe: 'probe 1',
  });
  assert.deepEqual(await release(page, { '/sw/stubs.js': probed(2) }), {
    worker: '/sw.js',
    probe: 'probe 2',
  });
  assert.deepEqual(await release(page, {}), { worker: '/sw.js', probe: 'probe 2' });
  assert.deepEqual(page.errors, []);
});

test('a release that changes only the first module sw.js imports updates an installed seven (#1022)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const changed = await release(page, {
    '/sw/integrity.js': `${integrity}export const PROBE = 1;\n`,
    '/sw/stubs.js': probed(3),
  });
  assert.deepEqual(changed, { worker: '/sw.js', probe: 'probe 3' });
  assert.deepEqual(page.errors, []);
});
