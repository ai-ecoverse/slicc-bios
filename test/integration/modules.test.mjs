import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const files = {
  'node_modules/esm-demo/package.json': JSON.stringify({
    type: 'module',
    exports: { '.': { node: './node.js', browser: './browser.js' } },
  }),
  'node_modules/esm-demo/browser.js':
    'import { randomUUID } from "node:crypto";\nimport cjs, { add } from "cjs-demo";\nexport const id = randomUUID();\nexport const sum = add(2, 3) + cjs.offset;',
  'node_modules/cjs-demo/package.json': JSON.stringify({ main: 'lib/index.js' }),
  'node_modules/cjs-demo/lib/index.js':
    'const util = require("./util");\nconst path = require("node:path");\nexports.add = (a, b) => a + b;\nexports.offset = util.offset;\nexports.hasPath = typeof path === "object";',
  'node_modules/cjs-demo/lib/util.js': 'module.exports = { offset: 10 };',
  'os/probe.js':
    'import { id, sum } from "esm-demo";\nimport { hasPath } from "cjs-demo";\nexport const result = { id, sum, hasPath, lazy: (await import("cjs-demo")).default.offset };',
};

test('loads an unbundled package graph with CommonJS and node builtins through the service worker', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const result = await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split('/');
      const name = parts.pop();
      let dir = root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    }
    const { result } = await import('/os/probe.js');
    const stub = await fetch('/__slicc/node/fs.js?names=readFile').then((response) =>
      response.text()
    );
    return { ...result, stub: stub.includes('export const readFile') };
  }, files);
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.sum, 15);
  assert.equal(result.hasPath, true);
  assert.equal(result.lazy, 10);
  assert.equal(result.stub, true);
});

test('the UI itself loads without an import map', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const maps = await page.evaluate(
    () => document.querySelectorAll('script[type="importmap"]').length
  );
  assert.equal(maps, 0);
});
