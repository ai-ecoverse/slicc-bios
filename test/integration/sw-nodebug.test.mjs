import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { withoutWorkerPause } from './sw-pause.mjs';

const chrome = await launch();
after(() => chrome.close());

test('an update with no debugger pause on workers opens the shell', async (t) => {
  const attachedWorkers = [];
  t.after(
    chrome.cdp.on(({ method, params = {} }) => {
      if (method !== 'Target.attachedToTarget' || params.targetInfo?.type !== 'service_worker')
        return;
      attachedWorkers.push(params.targetInfo.url ?? '');
    })
  );
  t.after(await withoutWorkerPause(chrome));
  const page = await chrome.page(t);
  const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
  chrome.overrides.set('/sw.js', current.replace('...isolation, ', ''));
  await page.goto('/');
  await page.until(() => location.pathname === '/os/');
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  chrome.overrides.delete('/sw.js');

  await boot(page);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.deepEqual(attachedWorkers, []);
  await run(page, 'echo "upgraded $((1 + 1))"');
  await shows(page, 'upgraded 2');
});
