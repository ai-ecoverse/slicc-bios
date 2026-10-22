import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, booted, watch } from './bios.mjs';
import { launch } from './chrome.mjs';
import { retryReplacedWorker } from './sw-activate.mjs';

const chrome = await launch();
after(() => chrome.close());

const root = new URL('../../', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28 });

function mainBuild() {
  const shallow = git('rev-parse', '--is-shallow-repository').toString().trim() === 'true';
  git('fetch', '--quiet', ...(shallow ? ['--depth=1'] : []), 'origin', 'main');
  const commit = git('rev-parse', 'FETCH_HEAD').toString().trim();
  const files = git('ls-tree', '-r', '--name-only', commit, 'src/')
    .toString()
    .split('\n')
    .filter(Boolean);
  return { commit, files };
}

async function differing({ commit, files }) {
  const changed = new Map();
  for (const file of files) {
    const deployed = git('show', `${commit}:${file}`);
    const ours = await readFile(new URL(file, root)).catch(() => null);
    if (!ours?.equals(deployed)) changed.set(`/${file.slice('src/'.length)}`, deployed);
  }
  return changed;
}

test('a seven installed from main’s build loads this build’s BIOS page under main’s worker and reaches the UI', async (t) => {
  const main = mainBuild();
  const changed = await differing(main);
  t.diagnostic(`main ${main.commit.slice(0, 8)}, ${changed.size} files differ`);
  const page = await chrome.page(t);
  t.after(retryReplacedWorker(chrome));
  for (const [path, body] of changed) chrome.overrides.set(path, body);
  await boot(page);
  const installed = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? null
  );
  assert.equal(installed, new URL('sw.js', chrome.url).href);
  chrome.overrides.clear();

  const bios = await watch(page);
  const mark = page.responses.length;
  await boot(page);
  const refused = page.responses
    .slice(mark)
    .filter((response) => response.status >= 400)
    .map((response) => `${response.status} ${new URL(response.url).pathname}`);
  assert.deepEqual(refused, []);
  assert.deepEqual(bios.states(), booted);
  assert.deepEqual(page.errors, []);
});
