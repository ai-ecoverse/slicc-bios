import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const KERNEL = 'node_modules/@ai-ecoverse/slicc-kernel';
const OLD = {
  version: '1.81.0',
  resolved: 'https://registry.npmjs.org/@ai-ecoverse/slicc-kernel/-/slicc-kernel-1.81.0.tgz',
  integrity:
    'sha512-hc1KHvrTaSS7nHS2D+0yX0oTs5Tx5gs0yQJOExK0nWSqjO8Dkefp5P013ucYkTeBXR3o9M3xVyayCU/4LbySjQ==',
};

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return '';
    }
  }, path);
}

test('an update that finds the network down stops with its error, and a reload once it is back installs it and stamps the modes', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const { readFileSync } = await import('node:fs');
  const shipped = JSON.parse(
    readFileSync(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8')
  );
  const older = structuredClone(shipped);
  older.packages[KERNEL] = { ...older.packages[KERNEL], ...OLD };
  const page = await chrome.page(t);
  chrome.overrides.set('/packages/package-lock.json', JSON.stringify(older));
  await page.goto('/');
  await ready(page);
  chrome.overrides.delete('/packages/package-lock.json');

  chrome.cdn.status = 503;
  const offline = await watch(page);
  const started = Date.now();
  await page.evaluate(() => location.assign('/'));
  await page.within(
    120000,
    () => document.querySelector('[data-step="packages"]')?.dataset.state === 'failed'
  );
  t.diagnostic(`offline: ${offline.texts('packages').at(-1)}`);
  assert.match(
    await page.evaluate(() => document.querySelector('[data-step="packages"] output').value),
    /^503 /
  );

  chrome.cdn.status = 0;
  chrome.cdn.requests.length = 0;
  const online = Date.now();
  await page.evaluate(() => location.reload());
  await ready(page);
  t.diagnostic(
    `back online: /os/ after ${Math.round((Date.now() - online) / 1000)} s, ${chrome.cdn.requests.filter((url) => url.endsWith('.tgz')).length} tarballs, ${Math.round((online - started) / 1000)} s offline`
  );
  const receipt = JSON.parse(await read(page, `var/lib/bios/${KERNEL}.json`));
  assert.equal(receipt.integrity, shipped.packages[KERNEL].integrity);
  assert.equal(receipt.modes, true);
  const shim = JSON.parse(
    await read(page, 'var/lib/bios/node_modules/@ai-ecoverse/wasi-pnpm.json')
  );
  assert.equal(shim.modes, true);
  assert.deepEqual(
    page.errors.filter((error) => !/^Error: 503 https:\/\/registry\.npmjs\.org\//.test(error)),
    []
  );
});

test('an installed seven whose modes still need their repair boots offline with a working terminal, whose wasm comes from OPFS as application/wasm through the integrity check, and repairs once the network is back', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await ready(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const walk = async (dir) => {
      for await (const handle of dir.values()) {
        if (handle.kind === 'directory') await walk(handle);
        else if (handle.name.endsWith('.json')) {
          const receipt = JSON.parse(await (await handle.getFile()).text());
          delete receipt.modes;
          const writable = await handle.createWritable();
          await writable.write(JSON.stringify(receipt));
          await writable.close();
        }
      }
    };
    let bios = root;
    for (const part of ['var', 'lib', 'bios']) bios = await bios.getDirectoryHandle(part);
    await walk(bios);
  });
  chrome.cdn.status = 503;
  await page.evaluate(() => location.assign('/'));
  await ready(page);
  const pending = JSON.parse(await read(page, `var/lib/bios/${KERNEL}.json`));
  assert.equal(pending.modes, undefined);
  const wasm = await page.evaluate(async () => {
    const url = new URL(customElements.get('slicc-terminal').wasmUrl);
    const response = await fetch(url);
    const type = response.headers.get('content-type');
    const module = await WebAssembly.compileStreaming(response).then(
      (compiled) => WebAssembly.Module.exports(compiled).length > 0,
      (error) => String(error)
    );
    return { path: url.pathname, status: response.status, type, module };
  });
  assert.deepEqual(wasm, {
    path: '/node_modules/@ai-ecoverse/slicc-spectrum/dist/ghostty-vt.wasm',
    status: 200,
    type: 'application/wasm',
    module: true,
  });
  chrome.cdn.status = 0;
  await page.evaluate(() => location.assign('/'));
  await ready(page);
  const repaired = JSON.parse(await read(page, `var/lib/bios/${KERNEL}.json`));
  assert.equal(repaired.modes, true);
  assert.deepEqual(page.errors, []);
});
