import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const textFile = /\.(js|mjs|html|css|svg|json)$/;

async function files(dir) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (textFile.test(entry.name)) found.push(path);
  }
  return found;
}

test('seven sets no cookies', async () => {
  const src = await files(fileURLToPath(new URL('../../src', import.meta.url)));
  for (const path of src) {
    const text = await readFile(path, 'utf8');
    assert.equal(text.includes('document.cookie'), false, path);
    assert.equal(text.includes('cookieStore'), false, path);
  }
  const served = [
    fileURLToPath(new URL('../../src/sw.js', import.meta.url)),
    ...(await files(fileURLToPath(new URL('../../src/sw', import.meta.url)))),
    ...(await files(fileURLToPath(new URL('../../edge', import.meta.url)))),
  ];
  for (const path of served) {
    const text = await readFile(path, 'utf8');
    assert.equal(/set-cookie/i.test(text), false, path);
  }
});
