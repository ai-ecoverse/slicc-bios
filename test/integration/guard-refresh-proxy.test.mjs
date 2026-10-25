import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { fixture, guardHost, ROW_MS, SCALE, targets } from './guard-set.mjs';

const selected = {
  ...set,
  vectors: set.vectors
    .filter((vector) => vector.id === 'C8.iframe-error')
    .map((vector) => ({ ...vector, targets: ['network-error'] })),
};

test('a failed ordinary iframe remains snapshot-readable on the proxy path', {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  assert.equal(selected.vectors.length, 1);
  const { clientFactory } = await guardHost(t, 'proxy');
  for (const variant of ['prompt', 'lagging']) {
    const result = await run(selected, {
      clientFactory: clientFactory('proxy'),
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
    assert.equal(result.results.length, 1);
    const row = result.results[0];
    process.stdout.write(`GUARD-REFRESH ${JSON.stringify({ variant, row })}\n`);
    assert.equal(row.control, 'pass', 'the ordinary control completes');
    assert.equal(row.guarded, 'pass', row.why);
    assert.equal(row.live, 'pass', 'the attempted navigation has live evidence');
  }
});
