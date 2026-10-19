import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

async function timed(page) {
  const start = Date.now();
  await page.goto('/');
  await page.until(() => location.pathname === '/os/');
  const ui = Date.now() - start;
  await ready(page);
  return { ui, prompt: Date.now() - start };
}

const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];

test('a cold boot and repeat boots through the BIOS reach the terminal prompt', async (t) => {
  const page = await chrome.page(t);
  const cold = await timed(page);
  const repeats = [];
  for (let run = 0; run < 3; run++) repeats.push(await timed(page));
  const warm = {
    ui: median(repeats.map((run) => run.ui)),
    prompt: median(repeats.map((run) => run.prompt)),
  };
  const line = `SPLASH-TIMING cold ui=${cold.ui} prompt=${cold.prompt} repeat ui=${warm.ui} prompt=${warm.prompt} runs=${JSON.stringify(repeats)}`;
  console.log(line);
  t.diagnostic(line);
  assert.ok(cold.prompt > 0 && warm.prompt > 0);
  assert.deepEqual(page.errors, []);
});
