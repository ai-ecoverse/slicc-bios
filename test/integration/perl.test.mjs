import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

const terminal = (page) =>
  page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });

test('prove runs a cone’s Perl tests through TAP::Harness', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id),
    'perl'
  );
  assert.equal(await actPackage(page, 'perl', 'install'), 'ok');
  assert.equal((await row(page, 'perl')).version, '5.42.0-11');
  const tap = Buffer.from(
    'use strict;\nuse Test::More tests => 2;\nok(1, "one");\nis(6 * 7, 42, "answer");\n'
  ).toString('base64');
  await run(
    page,
    `clear; cd /; sudo -u cone bash -c 'cd && mkdir -p t && echo ${tap} | base64 -d > t/answer.t && prove t; echo proved=$?'; echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await terminal(page);
  assert.match(text, /All tests successful/);
  assert.match(text, /proved=0/);
  assert.deepEqual(page.errors, []);
});
