import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

test('a script on PATH runs by its bare name under timeout and through env, whose spawns search PATH (slicc-kernel#1165)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(
    page,
    `clear; mkdir -p /tmp/pathbin && printf '#!/bin/sh\\necho ran-$1-$((40 + 2))\\n' > /tmp/pathbin/tidecheck && chmod 755 /tmp/pathbin/tidecheck; export PATH=/tmp/pathbin:$PATH; timeout 5 tidecheck viatimeout; echo timeout=$?; env tidecheck viaenv; echo env=$?; echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 120000);
  const text = await screen(page);
  assert.match(text, /ran-viatimeout-42/);
  assert.match(text, /timeout=0/);
  assert.match(text, /ran-viaenv-42/);
  assert.match(text, /env=0/);
  assert.deepEqual(page.errors, []);
});
