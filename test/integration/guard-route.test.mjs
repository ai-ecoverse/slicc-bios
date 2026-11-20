import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIN_EXTENSION_VERSION } from '../../src/seed/extension.js';
import { guardRoute, routeGaps } from './guard-route.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

test('a test guard refuses to be built without its route', () => {
  for (const missing of [undefined, null, '', 'kernel', { kind: 'extension' }])
    assert.throws(() => guardRoute(missing), /needs its route/, String(missing));
  assert.throws(() => guardRoute('link'), /needs the version/);
});

test('a test guard gets the route bios’s browser hook would give it', () => {
  assert.equal(guardRoute('devtools'), undefined);
  assert.deepEqual(guardRoute('extension'), { kind: 'extension', version: MIN_EXTENSION_VERSION });
  assert.deepEqual(guardRoute('extension', { version: '7.12.2' }), {
    kind: 'extension',
    version: '7.12.2',
  });
  assert.deepEqual(guardRoute('link', { version: '1.69.4' }), { kind: 'link', version: '1.69.4' });
});

test('the route check flags a guard over an extension or linked transport that passes no route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-route-'));
  const file = join(dir, 'sample.test.mjs');
  writeFileSync(
    file,
    [
      'guardProtected(extensionConnection(cdp), origin);',
      'guardProtected(await globalThis.sliccLinkedBrowsers()[0].open(), origin, new Map(), undefined);',
      "guardProtected(extensionConnection(cdp), origin, new Map(), guardRoute('extension'));",
    ].join('\n')
  );
  assert.deepEqual(routeGaps([file]), ['sample.test.mjs:1', 'sample.test.mjs:2']);
});

test('every test guard over an extension or linked transport passes its route', () => {
  const files = readdirSync(here)
    .filter((name) => name.endsWith('.mjs') && name !== 'guard-route.test.mjs')
    .map((name) => join(here, name));
  assert.deepEqual(routeGaps(files), []);
});
