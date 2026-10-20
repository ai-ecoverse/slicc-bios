import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { actPackage, boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const PINNED = JSON.parse(
  readFileSync(new URL('../../src/packages/optional/package.json', import.meta.url), 'utf8')
).dependencies['@ai-ecoverse/wasm-sqlite3'];

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

test('a cone makes a SQLite database, writes and reads it, and journal_mode=WAL leaves it usable', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id),
    'sqlite3'
  );
  assert.equal(await actPackage(page, 'sqlite3', 'install'), 'ok');
  assert.equal((await row(page, 'sqlite3')).version, PINNED);
  await run(
    page,
    `clear; cd /; sudo -u cone bash -c 'cd && echo first=$(sqlite3 tides.db "create table tide(height); insert into tide values (42); select height from tide;") && echo journal=$(sqlite3 tides.db "pragma journal_mode=wal;") && echo rows=$(sqlite3 tides.db "insert into tide values (43); select count(*) from tide;") && echo check=$(sqlite3 tides.db "pragma integrity_check;")'; echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await terminal(page);
  assert.match(text, /first=42/);
  assert.match(text, /journal=\w+/);
  assert.match(text, /rows=2/);
  assert.match(text, /check=ok/);
  assert.doesNotMatch(text, /not a database|Error/);
  assert.deepEqual(page.errors, []);
});
