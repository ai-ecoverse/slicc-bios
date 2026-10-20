import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';
import { shoot } from './shots.mjs';

const chrome = await launch();
after(() => chrome.close());

const pointer = () =>
  ['(pointer: fine)', '(pointer: coarse)', '(hover: hover)', '(any-pointer: fine)'].map(
    (query) => matchMedia(query).matches
  );

test('PM screenshots see a desktop’s fine pointer and hover, in light, dark and at 420, and the page gets its own pointer back afterwards', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const before = await page.evaluate(pointer);
  const seen = [];
  await page.expose('sliccShotPointer', (value) => seen.push(value));
  await shoot(page, 'pointer', {
    before: () =>
      window.sliccShotPointer(
        JSON.stringify(
          ['(pointer: fine)', '(pointer: coarse)', '(hover: hover)', '(any-pointer: fine)'].map(
            (query) => matchMedia(query).matches
          )
        )
      ),
  });
  assert.deepEqual(seen, [
    [true, false, true, true],
    [true, false, true, true],
    [true, false, true, true],
  ]);
  assert.deepEqual(await page.evaluate(pointer), before);
});
