import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { origins } from './cli-native-tap.mjs';
import { ordinaryProbe } from './guard-paint.mjs';

const copy = process.env.PROBE_COPY;
const base = process.env.PROBE_BASE;
const attachment = process.env.PROBE_ATTACHMENT;
const out = `artifacts/child-probe-${copy}`;
process.env.PROBE_STDERR_DIR = out;
const rows = [];
const states = ['drivable', 'closed'];

function phase(row, label) {
  assert.ok(row.control.shot >= 1000, `${label}: the raw marker paints`);
  assert.ok(row.control.cast.marked > 0, `${label}: the raw marker casts`);
  assert.equal(row.control.input, 'reached', `${label}: raw input reaches the marker`);
  assert.ok(states.includes(row.state), `${label}: ${row.state} is not a valid measured state`);
  if (row.state === 'drivable') {
    assert.ok(row.shot >= 1000, `${label}: the guarded marker paints`);
    assert.ok(row.cast.marked > 0, `${label}: the guarded marker casts`);
    assert.equal(row.input, 'reached', `${label}: guarded input reaches the marker`);
  } else {
    assert.equal(row.shot, 'refused', `${label}: closed paint is refused`);
    assert.equal(row.cast.start, 'refused', `${label}: a closed cast is refused`);
    assert.equal(row.cast.frames, 0, `${label}: no closed cast frame is delivered`);
    assert.equal(row.cast.marked, 0, `${label}: no marker is delivered`);
    assert.equal(row.input, 'refused', `${label}: closed input is refused`);
  }
}

test(`ordinary ${copy}: ten link OOPIF rounds`, { timeout: 40 * 60 * 1000 }, async (t) => {
  assert.ok(['ordinary-1', 'ordinary-2'].includes(copy));
  await mkdir(out, { recursive: true });
  for (let round = 1; round <= 10; round += 1) {
    await t.test(`round ${round}`, { timeout: 10 * 60 * 1000 }, async (roundTest) => {
      let row;
      try {
        process.env.PROBE_ROUND = String(round);
        row = await ordinaryProbe(roundTest);
      } catch (error) {
        row = { error: String(error.stack ?? error) };
      }
      const result = { base, copy, round, attachment, row };
      rows.push(result);
      process.stdout.write(
        `ORDINARY-PROBE-ROW ${JSON.stringify(origins({ ...result, row: { ...row, transportEvents: undefined } }))}\n`
      );
      await writeFile(`${out}/ordinary-${round}.json`, `${JSON.stringify(origins(result))}\n`);
      assert.equal(row.attach, 'ok', row.error ?? 'the ordinary page attaches');
      assert.equal(row.placement.remote, true, 'the preloaded frame is an OOPIF');
      assert.ok(
        row.added.control.frames.filter((host) => host === 'localhost').length >= 2,
        'the added frame is also an OOPIF'
      );
      phase(row, 'preloaded');
      phase(row.added, 'added');
      phase(row.removed, 'removed');
    });
  }
  const summary = { base, copy, attachment, rows: rows.length, phases: {} };
  for (const name of ['preloaded', 'added', 'removed']) {
    const phaseRows = rows.map(({ row }) => (name === 'preloaded' ? row : row[name]));
    summary.phases[name] = {
      drivable: phaseRows.filter((row) => row?.state === 'drivable').length,
      closed: phaseRows.filter((row) => row?.state === 'closed').length,
      failed: phaseRows.filter((row) => !states.includes(row?.state)).length,
    };
  }
  await writeFile(`${out}/summary.json`, `${JSON.stringify(summary)}\n`);
  process.stdout.write(`ORDINARY-PROBE-SUMMARY ${JSON.stringify(summary)}\n`);
  assert.equal(rows.length, 10);
});
