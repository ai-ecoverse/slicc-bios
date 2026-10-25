import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { origins } from './cli-native-tap.mjs';
import { lateRemoteProbe } from './guard-paint.mjs';

const MARKED = 1000;

const copy = process.env.PROBE_COPY;
const out = `artifacts/late-remote-${copy}`;
process.env.PROBE_STDERR_DIR = out;
process.env.PROBE_ROUND = '1';

test('the late remote page attaches after its ordinary empty document and restores', {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  await mkdir(out, { recursive: true });
  const row = await lateRemoteProbe(t);
  await writeFile(`${out}/row.json`, `${JSON.stringify(origins(row))}\n`);
  process.stdout.write(`LATE-REMOTE-PROBE ${JSON.stringify(origins(row))}\n`);
  assert.equal(
    row.restore,
    'BackForwardCacheRestore',
    'the protected page is restored without a new document request'
  );
  assert.ok(row.control.shot >= MARKED, 'the late frame paints without the guard');
  assert.equal(row.attach, 'ok', 'the ordinary page attaches');
  assert.equal(row.cast.start, 'ok', 'the cast starts on the ordinary page');
  assert.equal(row.pending, true, 'the screenshot was pending before the restore');
  assert.equal(row.locked, 'refused', 'the page is locked before post-lock frames are counted');
  assert.equal(
    row.lateShot,
    'refused',
    'a delayed screenshot answer is refused after the page locks'
  );
  assert.equal(row.cast.marked, 0, 'no cast frame shows the late frame');
  assert.equal(row.cast.frames, 0, 'the running cast stops when the page locks');
  assert.ok(
    row.shot === 'refused' || row.shot === 0,
    'a screenshot after the frame appeared shows none of it'
  );
});
