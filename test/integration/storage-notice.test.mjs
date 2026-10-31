import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const notice = (page, chromium) =>
  page.evaluate(async (chromium) => {
    const { keepStorage } = await import('/os/storage.js');
    const shown = [];
    const keep = keepStorage({
      notices: { show: (item) => shown.push(item), remove() {} },
      prompts: { offered: () => false, on() {} },
      storage: { persisted: async () => false, persist: async () => false },
      ...(chromium === null ? {} : { chromium }),
    });
    await keep.sent();
    return shown[0].body;
  }, chromium);

test('only Chrome is told what Chrome does with seven’s files', async (t) => {
  const page = await chrome.page(t);
  await ready(page);
  assert.equal(
    await notice(page, null),
    'Chrome may clear seven’s files and chats when disk space runs low. Bookmark seven to keep them.'
  );
  assert.equal(
    await notice(page, false),
    'This browser may clear seven’s files and chats when it needs the space.'
  );
});
