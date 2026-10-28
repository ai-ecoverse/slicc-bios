import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { fixture, guardHost, ROW_MS, SCALE, targets } from './guard-set.mjs';

const vector = set.vectors.find((vector) => vector.id === 'C4.script-cross-site');

for (const target of ['seven', 'vault']) {
  for (const variant of ['prompt', 'lagging']) {
    test(`a scripted ${target} frame completes its refused navigation on the link path (${variant})`, {
      timeout: 10 * 60 * 1000,
    }, async (t) => {
      assert.ok(vector);
      const selected = { ...set, vectors: [{ ...vector, targets: [target] }] };
      const clientFactory = await guardHost(t, 'link');
      for (let round = 1; round <= 3; round += 1) {
        const execution = await run(selected, {
          clientFactory: clientFactory('link'),
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
        });
        assert.equal(execution.results.length, 1);
        const row = execution.results[0];
        process.stdout.write(`GUARD-REFRESH ${JSON.stringify({ round, row })}\n`);
        assert.equal(row.control, 'pass', 'the ordinary control completes');
        assert.equal(row.guarded, 'pass', row.why);
        assert.equal(row.live, 'pass', 'the attempted navigation has live evidence');
      }
    });
  }
}
