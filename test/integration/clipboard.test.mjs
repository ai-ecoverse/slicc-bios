import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const fake = `
  window.fakeClipboard = { text: '', refuse: false };
  const refusal = () => new DOMException('Document is not focused.', 'NotAllowedError');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: async () => {
        if (window.fakeClipboard.refuse) throw refusal();
        return window.fakeClipboard.text;
      },
      writeText: async (text) => {
        if (window.fakeClipboard.refuse) throw refusal();
        window.fakeClipboard.text = text;
      },
    },
  });
`;

test('/dev/clipboard, pbcopy, pbpaste and xclip write and read the browser clipboard, and a refused read or write fails with EACCES', async (t) => {
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  await boot(page);
  await run(page, 'printf hi > /dev/clipboard; echo "wrote $?"');
  await shows(page, 'wrote 0');
  assert.equal(await page.evaluate(() => window.fakeClipboard.text), 'hi');
  await run(page, 'echo "read [$(cat /dev/clipboard)]"');
  await shows(page, 'read [hi]');
  await run(page, 'printf hi | pbcopy; echo "pasted [$(pbpaste)]"');
  await shows(page, 'pasted [hi]');
  await run(
    page,
    'printf from-xclip | xclip -in -selection clipboard; echo "xclip [$(xclip -o -selection clipboard)]"'
  );
  await shows(page, 'xclip [from-xclip]');
  assert.equal(await page.evaluate(() => window.fakeClipboard.text), 'from-xclip');
  await page.evaluate(() => {
    window.fakeClipboard.refuse = true;
  });
  await run(page, 'cat /dev/clipboard; echo "refused $?"');
  await shows(page, 'cat: /dev/clipboard: Permission denied');
  await shows(page, 'refused 1');
  await run(page, 'printf x | cat > /dev/clipboard; echo "write refused $?"');
  await shows(page, 'cat: write error: Permission denied');
  await shows(page, 'write refused 1');
  assert.equal(await page.evaluate(() => window.fakeClipboard.text), 'from-xclip');
  assert.deepEqual(page.errors, []);
});
