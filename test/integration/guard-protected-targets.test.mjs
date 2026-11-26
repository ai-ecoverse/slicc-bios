import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { protection } from '../../src/seed/guard.js';

const vectors = JSON.parse(
  await readFile(new URL(import.meta.resolve('@ai-ecoverse/slicc-browsers/protected.json')))
);

const ROUTES = ['devtools', 'extension', 'link'];
const MAPPED = ['url', 'type', 'previous', 'opener', 'contextOrigin'];
const ERROR_PAGE =
  'bios never hands target() this field: its target() calls pass Chrome’s TargetInfo or the guard’s own { url, type, previous, opener }, and the guard reads a failed load from Page.frameNavigated’s frame.unreachableUrl into its error-frame state instead';
const UNMAPPED = {
  documentURL: ERROR_PAGE,
  unreachableURL: ERROR_PAGE,
  navigating: ERROR_PAGE,
};

const unmapped = (row) => Object.keys(row).filter((field) => Object.hasOwn(UNMAPPED, field));
const label = (row, index) => `targets[${index}] ${JSON.stringify(row)}`;

const judged = (is, { url, type, previous, opener, contextOrigin }) =>
  Boolean(
    is.target({ url, type, previous, opener }) ||
      (contextOrigin !== undefined && is.url(contextOrigin))
  );

test('every shared protected target descriptor field maps onto bios’s target path or is named as unmapped', () => {
  assert.ok(vectors.targets.length > 0);
  assert.ok(vectors.targets.some((row) => Object.hasOwn(row, 'contextOrigin')));
  const unknown = vectors.targets.flatMap((row, index) =>
    Object.keys(row)
      .filter(
        (field) =>
          field !== 'protected' && !MAPPED.includes(field) && !Object.hasOwn(UNMAPPED, field)
      )
      .map((field) => `${label(row, index)}: ${field} is neither mapped nor named`)
  );
  assert.deepEqual(unknown, []);
  for (const [index, row] of vectors.targets.entries())
    for (const field of unmapped(row))
      console.log(`GUARD-TARGET-UNMAPPED ${label(row, index)}: ${field}: ${UNMAPPED[field]}`);
});

for (const route of ROUTES)
  test(`on the ${route} route, bios judges every mapped shared target descriptor as protected.json does, a contextOrigin as the default context’s reported origin`, () => {
    const is = protection(vectors.origins, { cut: route === 'link' });
    const rows = vectors.targets
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => unmapped(row).length === 0);
    const disagreements = rows
      .filter(({ row }) => judged(is, row) !== row.protected)
      .map(({ row, index }) => `${label(row, index)}: bios says ${judged(is, row)}`);
    console.log(
      `ROW-OBSERVED protected-targets ${JSON.stringify({
        route,
        judged: rows.length,
        unmapped: vectors.targets.length - rows.length,
        contextOrigin: rows.filter(({ row }) => Object.hasOwn(row, 'contextOrigin')).length,
        disagreements,
      })}`
    );
    assert.deepEqual(disagreements, []);
  });
