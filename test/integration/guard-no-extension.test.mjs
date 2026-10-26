import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const chrome = await launch({ extension: false });
const { port } = await devtools(chrome);
after(() => chrome.close());
const fakeExtension = extensionOver(await debuggerUrl(port));

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/').filter(Boolean);
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test('in a Chrome without the harness extension, the guard still drives an ordinary page and keeps seven’s own origin out of reach', async (t) => {
  assert.equal(chrome.extension ?? null, null);
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(extension.close);
  await boot(page);
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.sliccHarnessExtension ?? null),
    null
  );
  chrome.overrides.set('/plain.html', '<!doctype html><title>plain</title><h1>Plain page</h1>');
  const plain = new URL('/plain.html', chrome.url);
  plain.hostname = 'localhost';
  const own = new URL(chrome.url).origin;
  await run(
    page,
    `playwright-cli open ${plain.href} > /tmp/pw 2>&1 && playwright-cli snapshot >> /tmp/pw 2>&1; echo pw-$? >> /tmp/pw; playwright-cli goto ${own}/ > /tmp/own 2>&1; echo own-$? >> /tmp/own; echo "pw-""done"`
  );
  await shows(page, 'pw-done', 120000);
  const pw = await read(page, '/tmp/pw');
  assert.match(pw, /heading "Plain page"/, pw);
  assert.match(pw, /pw-0/, pw);
  const walked = await read(page, '/tmp/own');
  assert.match(walked, /slicc: refused/, walked);
  assert.doesNotMatch(walked, /own-0/, walked);
});
