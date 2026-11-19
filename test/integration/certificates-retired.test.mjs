import assert from 'node:assert/strict';
import { test } from 'node:test';
import { certificate, dropCertificate, keptFingerprints } from '../../src/seed/follow.js';

globalThis.IDBKeyRange ??= { bound: (lower, upper) => ({ lower, upper }) };

function memoryIdb() {
  const data = new Map();
  const later = (run) => setTimeout(run, 0);
  const database = {
    close() {},
    transaction() {
      const tx = { pending: 0 };
      const request = (run) => {
        const asked = {};
        tx.pending += 1;
        later(() => {
          asked.result = run();
          asked.onsuccess?.();
          tx.pending -= 1;
          later(() => {
            if (!tx.pending && !tx.done) {
              tx.done = true;
              tx.oncomplete?.();
            }
          });
        });
        return asked;
      };
      tx.objectStore = () => ({
        get: (key) => request(() => data.get(key)),
        put: (value, key) => request(() => data.set(key, value)),
        delete: (key) => request(() => data.delete(key)),
        getAll: ({ lower, upper }) =>
          request(() =>
            [...data.keys()]
              .filter((key) => key >= lower && key <= upper)
              .sort()
              .map((key) => data.get(key))
          ),
      });
      return tx;
    },
  };
  return {
    data,
    open() {
      const opening = {};
      later(() => {
        opening.result = database;
        opening.onsuccess?.();
      });
      return opening;
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;
let made = 0;
function minted(expires) {
  made += 1;
  const hex = made.toString(16).padStart(4, '0');
  return {
    expires,
    print: hex.repeat(16),
    getFingerprints: () => [{ algorithm: 'sha-256', value: hex.repeat(16).match(/../g).join(':') }],
  };
}

test('a certificate() or dropCertificate() call that names no live links never drops a retired print, past 256 of them and past a year', async () => {
  const idb = memoryIdb();
  const at = 10_000 * DAY;
  const past = at + 400 * DAY;
  const first = minted(at + 365 * DAY);
  await certificate('link:https://hub.test', { idb, now: () => at, generate: async () => first });
  const retired = [];
  for (let i = 0; i < 300; i += 1) {
    const before = await certificate('link:https://hub.test', {
      idb,
      now: () => at,
      live: () => retired,
      generate: async () => minted(at + 365 * DAY),
    });
    retired.push(before.print);
    await dropCertificate('link:https://hub.test', { idb, now: () => at, live: () => retired });
  }
  assert.deepEqual(
    (await keptFingerprints('link:', { idb })).sort(),
    [...retired].sort(),
    'the setup keeps every print a live link carries'
  );
  const current = minted(at + 365 * DAY);
  await certificate('link:https://hub.test', {
    idb,
    now: () => at,
    live: () => retired,
    generate: async () => current,
  });
  const renewed = minted(past + 365 * DAY);
  await certificate('link:https://hub.test', {
    idb,
    now: () => past,
    generate: async () => renewed,
  });
  assert.deepEqual(
    (await keptFingerprints('link:', { idb })).sort(),
    [...retired, current.print, renewed.print].sort(),
    'a bare renewal a year later dropped retired prints'
  );
  await dropCertificate('link:https://hub.test', { idb, now: () => past + DAY });
  assert.deepEqual(
    (await keptFingerprints('link:', { idb })).sort(),
    [...retired, current.print, renewed.print].sort(),
    'a bare drop dropped retired prints'
  );
});
