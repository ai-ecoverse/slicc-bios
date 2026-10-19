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

async function installed(page) {
  await page.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id),
    'sqlite3'
  );
  assert.equal(await actPackage(page, 'sqlite3', 'install'), 'ok');
}

const WRITER = [
  '#!/bin/bash',
  '{ echo ".timeout 20000"; for i in $(seq 1 200); do echo "insert into tide values (\'$2\', $i);"; done; } | sqlite3 "$1" 2> /tmp/tide-$2.err',
  'echo "$2 committed $((200 - $(grep -c . /tmp/tide-$2.err)))"',
].join('\n');

async function race(page, first, second) {
  await run(
    page,
    `clear; cd /; echo ${Buffer.from(`${WRITER}\n`).toString('base64')} | base64 -d > /usr/local/bin/tide-writer; chmod 755 /usr/local/bin/tide-writer; tide-writer ${first} root & sudo -u cone tide-writer ${second} cone & wait; for w in root cone; do echo "$w stored $(sqlite3 ${first} "select count(*) from tide where who = '$w';")"; done; echo raced-$((40 + 2))`
  );
  await shows(page, 'raced-42', 10 * 60 * 1000);
  const text = await terminal(page);
  for (const who of ['root', 'cone']) {
    const committed = Number(text.match(new RegExp(`${who} committed (\\d+)`))?.[1]);
    const stored = Number(text.match(new RegExp(`${who} stored (\\d+)`))?.[1]);
    assert.ok(committed > 0, `${who} committed rows\n${text}`);
    assert.equal(stored, committed, `every row ${who} committed is in the database\n${text}`);
  }
}

test('kernel#665: root and a cone insert into one SQLite database at once, and every committed row is there', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await installed(page);
  await run(
    page,
    "clear; mkdir -p /var/tmp/tides && chmod 777 /var/tmp/tides && sqlite3 /var/tmp/tides/one.db 'create table tide(who, n);' && chmod 666 /var/tmp/tides/one.db; echo made-$((40 + 2))"
  );
  await shows(page, 'made-42');
  await race(page, '/var/tmp/tides/one.db', '/var/tmp/tides/one.db');
  assert.deepEqual(page.errors, []);
});

test('kernel#665 and #704: root and a cone write one SQLite database through two hard-link names on tmpfs, and every committed row is there', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await installed(page);
  await run(
    page,
    "clear; mkdir -p /mnt/tides && mount -t tmpfs none /mnt/tides && chmod 777 /mnt/tides && sqlite3 /mnt/tides/a.db 'create table tide(who, n);' && chmod 666 /mnt/tides/a.db && ln /mnt/tides/a.db /mnt/tides/b.db; echo links=$(stat -c %h /mnt/tides/a.db); echo made-$((40 + 2))"
  );
  await shows(page, 'made-42');
  assert.match(await terminal(page), /links=2/);
  await race(page, '/mnt/tides/a.db', '/mnt/tides/b.db');
  assert.deepEqual(page.errors, []);
});
