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
    'const util = require("./util");\nconst path = require("node:path");\nexports.add = (a, b) => a + b;\nexports.offset = util.offset;\nexports.own = util.own;\nexports.same = util.same;\nexports.hasPath = typeof path === "object";\nexports.platform = process.platform === "win32" || global.TESTING_WINDOWS ? "windows" : process.platform;\nexports.env = typeof process.env.OSTYPE;\nprocess.env.SLICC_SEEN = "yes";',
  'node_modules/cjs-demo/lib/util.js':
    'const global = globalThis;\nconst process = { platform: "own" };\nmodule.exports = { offset: 10, own: process.platform, same: global === globalThis };',
  'os/probe.js':
    'import { id, sum } from "esm-demo";\nimport { hasPath, platform, env, own, same } from "cjs-demo";\nexport const result = { id, sum, hasPath, platform, env, own, same, seen: globalThis.__slicc_process.env.SLICC_SEEN, lazy: (await import("cjs-demo")).default.offset };',
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
  assert.equal(result.platform, 'browser');
  assert.equal(result.env, 'undefined');
  assert.equal(result.seen, 'yes');
  assert.equal(result.own, 'own');
  assert.equal(result.same, true);
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

test('node:worker_threads starts a module worker with workerData and a parentPort', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const result = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const os = await root.getDirectoryHandle('os', { create: true });
    const writable = await (await os.getFileHandle('echo.js', { create: true })).createWritable();
    await writable.write(
      'import { parentPort, isMainThread } from "node:worker_threads";\nconst { workerData } = await import("node:worker_threads");\nparentPort.on("message", (message) => parentPort.postMessage({ workerData, isMainThread, echo: message }));'
    );
    await writable.close();
    const threads = await import(
      '/__slicc/node/worker_threads.js?names=Worker,isMainThread,MessageChannel'
    );
    const worker = new threads.Worker('/os/echo.js', { workerData: { seed: 7 } });
    const reply = await new Promise((resolve, reject) => {
      worker.on('message', resolve).on('error', reject);
      worker.postMessage('ping');
    });
    const code = await worker.terminate();
    let missing = '';
    try {
      threads.MessageChannel();
    } catch (error) {
      missing = error.message;
    }
    return { reply, code, main: threads.isMainThread, missing, fallback: threads.default.threadId };
  });
  assert.deepEqual(result.reply, { workerData: { seed: 7 }, isMainThread: false, echo: 'ping' });
  assert.equal(result.code, 1);
  assert.equal(result.main, true);
  assert.match(result.missing, /node:worker_threads\.MessageChannel is not available/);
  assert.equal(result.fallback, 0);
});
