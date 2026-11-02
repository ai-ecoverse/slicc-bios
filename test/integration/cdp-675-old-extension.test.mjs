import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { oldRouteExtension } from './cdp-675-old-extension.mjs';

test('the old-route fixture selects the real historical extension rather than the moving main default', async () => {
  assert.equal(oldRouteExtension.version, '7.10.0');
  assert.match(oldRouteExtension.url, /releases\/download\/v7\.10\.0\/slicc-extension\.zip$/);
  assert.equal(
    oldRouteExtension.sha256,
    '9ee54be7897f5e7078363d1aee20016f2d233274863b40323e00a4168d81f458'
  );
  const source = await readFile(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
  assert.match(source, /extension: oldRoute \? oldRouteExtension : undefined/);
});
