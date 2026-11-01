import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { protection } from '../../src/seed/guard.js';

const vectors = JSON.parse(
  await readFile(new URL(import.meta.resolve('@ai-ecoverse/slicc-browsers/protected.json')))
);

test('bios classifies every shared domain-premise origin and page as protected', () => {
  const guard = protection('https://own.example.test');
  const cases = vectors.urls.filter((vector) => vector.url.endsWith('/cdp-premise'));
  assert.equal(cases.length, 10);
  for (const item of cases) {
    assert.equal(item.protected, true, item.url);
    assert.equal(guard.url(item.url), true, item.url);
    assert.equal(guard.target({ url: item.url, type: 'page' }), true, item.url);
  }
});
