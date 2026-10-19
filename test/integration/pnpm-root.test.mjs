import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

test('pnpm add in a fresh directory makes it its own project and never touches /package.json (homescoop#1251, #630)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(
    page,
    `clear; cd /; printf '{"name":"root-marker","private":true}\\n' > /package.json; before=$(sha256sum /package.json | cut -c1-16); rm -rf /tmp/fresh /tmp/tidedep && mkdir -p /tmp/tidedep /tmp/fresh && printf '{"name":"tidedep","version":"1.0.0"}\\n' > /tmp/tidedep/package.json && cd /tmp/fresh && pnpm add file:/tmp/tidedep > /tmp/fresh.log 2>&1; echo add=$?; after=$(sha256sum /package.json | cut -c1-16); [ "$before" = "$after" ] && echo root-$((1 + 1))-untouched; grep -c tidedep /tmp/fresh/package.json | sed 's/^/own=/'; grep -c tidedep /package.json | sed 's/^/rootdep=/'; rm -f /package.json /pnpm-lock.yaml; cd /; echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await screen(page);
  assert.match(text, /add=0/, text);
  assert.match(text, /own=1/, text);
  assert.match(text, /rootdep=0/, text);
  assert.match(text, /root-2-untouched/, text);
  assert.deepEqual(page.errors, []);
});
