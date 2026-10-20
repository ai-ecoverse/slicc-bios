import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({
  extensions: [fileURLToPath(new URL('./fixtures/injected-frame', import.meta.url))],
});
after(() => chrome.close());

test('with a content-script extension that shares seven’s window, a tab opened in front of seven still lets the harness read its terminal (bios#658)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url: 'about:blank' });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined));
  assert.equal(await page.evaluate(() => document.visibilityState), 'hidden');
  await run(page, 'echo shown-$((20+22))');
  await shows(page, 'shown-42', 30000);
  assert.match(await screen(page), /shown-42/);
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
});
