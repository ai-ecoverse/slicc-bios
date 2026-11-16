import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';

const chrome = await launch({ tools: false, timeout: 120000, intercept: [] });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

const bash = 'node_modules/@ai-ecoverse/wasm-bash';
const locked = JSON.parse(
  await readFile(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8')
).packages[bash];
const older =
  'sha512-pusddMmR2Y7k1fSDtF8vCNzPcpe4LCPEvwPhsxhnx9V7NmMcdudBvPE1nKLzetnqNQtXLjVaMNvKPxzrLO9KGw==';
const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml'];

async function downgrade() {
  for (const file of files) {
    const text = await readFile(new URL(`../../src/packages/${file}`, import.meta.url), 'utf8');
    const pinned = text.replaceAll(locked.version, '5.3.0-13').replaceAll(locked.integrity, older);
    chrome.overrides.set(`/packages/${file}`, pinned);
  }
}

const row = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'bios')
  );

test('an update whose pnpm goes quiet is stopped after 3 minutes, fails its row saying so, and lets go of the packages lock', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  registry.reset();
  await downgrade();
  await boot(page, ['slicc:/home# ', 'slicc:/home$ '], { tools: false });
  assert.equal((await row(page)).state, 'current');

  registry.hold = new RegExp(`/wasm-bash-${locked.version.replaceAll('.', '\\.')}\\.tgz$`);
  for (const file of files) chrome.overrides.delete(`/packages/${file}`);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.within(60000, async () => {
    const { held = [] } = await navigator.locks.query();
    return held.some(({ name }) => name === 'slicc-packages');
  });
  const bios = await page.within(8 * 60 * 1000, () => {
    const item = document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((entry) => entry.id === 'bios');
    return item?.state === 'failed' && item;
  });
  assert.match(bios.log ?? '', /\npnpm wrote nothing for 180 s$/, JSON.stringify(bios));
  assert.ok(
    registry.asked.some((url) => registry.hold.test(url)),
    'the update asked npm for the held tarball'
  );
  const { held = [] } = await page.evaluate(() => navigator.locks.query());
  assert.deepEqual(
    held.filter(({ name }) => name === 'slicc-packages'),
    [],
    'the update let go of slicc-packages'
  );
  registry.hold = null;
});
