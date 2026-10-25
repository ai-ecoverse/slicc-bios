import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { fixture, guardHost, ROW_MS, targets } from './guard-set.mjs';

const selected = {
  ...set,
  vectors: set.vectors
    .filter((vector) => vector.id === 'C4.static-cross-site')
    .map((vector) => ({ ...vector, targets: ['seven'] })),
};

test('a static cross-site frame completes its refused navigation on the link path', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  assert.equal(selected.vectors.length, 1);
  const { clientFactory } = await guardHost(t, 'link');
  for (let round = 1; round <= 3; round += 1) {
    const result = await run(selected, {
      clientFactory: clientFactory('link'),
      rowTimeoutMs: ROW_MS,
      settleScale: 1,
      targets,
      capabilities: {
        autoAttach: true,
        browserSession: true,
        browserContexts: true,
        chromeUrlsAttach: true,
        extensionWorld: true,
      },
      variant: 'prompt',
      fixture,
    });
    assert.equal(result.results.length, 1);
    const row = result.results[0];
    process.stdout.write(`GUARD-REFRESH ${JSON.stringify({ round, row })}\n`);
    assert.equal(row.control, 'pass', 'the ordinary control completes');
    assert.equal(row.guarded, 'pass', row.why);
    assert.equal(row.live, 'pass', 'the attempted navigation has live evidence');
  }
});
