import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { origins } from './cli-native-tap.mjs';
import { fixture, guardHost, ROW_MS, SCALE, targets } from './guard-set.mjs';

const copy = Number(process.env.PROBE_COPY);
const loaded = process.env.PROBE_CPU === '1';
const selected = {
  ...set,
  vectors: set.vectors
    .filter((vector) => vector.id === 'C8.iframe-error')
    .map((vector) => ({ ...vector, targets: ['network-error'] })),
};
const results = [];
const base = process.env.PROBE_BASE;
const out = `artifacts/error-probe-${copy}`;

test(`copy ${copy}: ten proxy error-frame rounds${loaded ? ' with CPU load' : ''}`, {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  assert.equal(selected.vectors.length, 1);
  assert.ok(Number.isInteger(copy) && copy >= 1 && copy <= 6);
  await mkdir(out, { recursive: true });
  const workers = loaded
    ? Array.from(
        { length: Math.min(2, availableParallelism()) },
        () =>
          new Worker(
            `
    const { parentPort } = require('node:worker_threads');
    const end = Date.now() + 45 * 60 * 1000;
    let value = 1;
    parentPort.postMessage('ready');
    while (Date.now() < end) {
      for (let n = 0; n < 1000000; n += 1) value = Math.sin(value + n);
    }
    parentPort.postMessage(value);
  `,
            { eval: true }
          )
      )
    : [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        })
    )
  );
  process.stdout.write(
    `ERROR-PROBE-LOAD ${JSON.stringify({ base, copy, loaded, workers: workers.length, cpus: availableParallelism() })}\n`
  );
  for (let round = 1; round <= 10; round += 1) {
    await t.test(`round ${round}`, { timeout: 10 * 60 * 1000 }, async (roundTest) => {
      let transportEvents = [];
      let evidence;
      let row;
      try {
        const variant = round % 2 ? 'prompt' : 'lagging';
        const { clientFactory } = await guardHost(roundTest, 'proxy');
        const factory = clientFactory('proxy');
        const execution = await run(selected, {
          clientFactory: async (configuration) => {
            const made = await factory(configuration);
            transportEvents = made.client.transportEvents;
            return made;
          },
          rowTimeoutMs: ROW_MS,
          settleScale: SCALE[variant] ?? 1,
          targets,
          capabilities: {
            autoAttach: true,
            browserSession: true,
            browserContexts: true,
            chromeUrlsAttach: true,
            extensionWorld: true,
          },
          variant,
          fixture,
          debug: (data) => {
            if (data.calls) {
              evidence ??= {};
              evidence[data.side] = data;
            }
          },
        });
        assert.equal(execution.results.length, 1);
        row = execution.results[0];
      } catch (error) {
        row = {
          control: 'incomplete',
          guarded: 'incomplete',
          live: 'incomplete',
          error: String(error.stack ?? error),
        };
      }
      const result = { base, copy, round, variant: round % 2 ? 'prompt' : 'lagging', loaded, row };
      results.push(result);
      process.stdout.write(`ERROR-PROBE-ROW ${JSON.stringify(origins(result))}\n`);
      await writeFile(
        `${out}/round-${round}.json`,
        `${JSON.stringify(origins({ ...result, transportEvents, evidence }))}\n`
      );
      assert.equal(row.control, 'pass', 'the raw control completes');
      assert.equal(row.guarded, 'pass', row.why ?? row.error ?? 'the guarded vector passes');
      assert.equal(row.live, 'pass', 'the guarded attempt has live evidence');
    });
  }
  const counts = {
    base,
    copy,
    loaded,
    rows: results.length,
    controlPass: results.filter((result) => result.row.control === 'pass').length,
    guardedPass: results.filter((result) => result.row.guarded === 'pass').length,
    guardedFail: results.filter((result) => result.row.guarded === 'fail').length,
    incomplete: results.filter((result) => result.row.guarded === 'incomplete').length,
  };
  await writeFile(`${out}/summary.json`, `${JSON.stringify(counts)}\n`);
  process.stdout.write(`ERROR-PROBE-SUMMARY ${JSON.stringify(counts)}\n`);
  assert.equal(results.length, 10);
});
