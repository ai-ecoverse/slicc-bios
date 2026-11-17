import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { booted, ready, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const installer = await readFile(new URL('../../src/installer.js', import.meta.url), 'utf8');
const CLOSING = /The database connection is closing/;

const CLOSED_NOTE = 'ledger-closed-probe';

const closer = `
const CLOSED_NOTE = ${JSON.stringify(CLOSED_NOTE)};
const ledgers = [];
const openDatabase = IDBFactory.prototype.open;
IDBFactory.prototype.open = function (name, ...rest) {
  const request = openDatabase.call(this, name, ...rest);
  if (name === 'slicc-bios-integrity') {
    request.addEventListener('success', () => ledgers.push(request.result));
  }
  return request;
};
self.addEventListener('connect', ({ ports: [port] }) => {
  port.addEventListener('message', ({ data }) => {
    if (data.op !== 'install') return;
    const closed = ledgers.length;
    for (const db of ledgers.splice(0)) db.close();
    const note = indexedDB.open(CLOSED_NOTE, 1);
    note.onupgradeneeded = () => note.result.createObjectStore('closed');
    note.onsuccess = () => {
      const transaction = note.result.transaction('closed', 'readwrite');
      transaction.objectStore('closed').put(closed, 'count');
      transaction.oncomplete = () => note.result.close();
    };
  });
});
`;

async function settled(bios, ms = 120000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = bios
      .states()
      .map((entry) => entry.split(':'))
      .findLast(
        ([step, state]) => step === 'seed' && (state === 'done' || state === 'failed')
      )?.[1];
    if (state) return { state, text: bios.texts('seed').at(-1) ?? '' };
    assert.ok(Date.now() < deadline, `the seed step never ended: ${bios.states().join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('a BIOS whose installer finds its IndexedDB connection closed before the seed opens it again and boots, as Safari on iOS closes it on its own', async (t) => {
  const page = await chrome.page(t);
  chrome.overrides.set('/installer.js', `${closer}${installer}`);
  const bios = await watch(page);
  await page.goto('/');
  const seed = await settled(bios);
  assert.doesNotMatch(seed.text, CLOSING);
  assert.equal(seed.state, 'done', seed.text);
  await ready(page, undefined, { tools: false });
  assert.deepEqual(bios.states(), booted);
  const closed = await page.evaluate(
    (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const read = request.result.transaction('closed').objectStore('closed').get('count');
          read.onsuccess = () => resolve(read.result ?? 0);
        };
      }),
    CLOSED_NOTE
  );
  assert.ok(closed >= 1, `closed ${closed} ledger connections`);
  assert.deepEqual(page.errors, []);
});
