import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const rows = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .filter((item) => item.id === 'dig' || item.id === 'bind')
        .map((item) => [item.id, { state: item.state, version: item.version ?? null }])
    )
  );

test('installing the BIND tools over an earlier dig removes wasi-dig first, so dig, host and nslookup are BIND’s, and they look up names with no server argument through the kernel’s DNS stub (homescoop#1282)', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(
    page,
    'clear; pnpm add -g @ai-ecoverse/wasi-dig > /tmp/dig-add.log 2>&1; echo "dig-added=$?-$((40 + 2))"'
  );
  await shows(page, 'dig-added=0-42', 5 * 60 * 1000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.within(
    120000,
    () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === 'dig')?.state === 'installed'
  );
  assert.equal(await actPackage(page, 'bind', 'install'), 'ok');
  const after = await rows(page);
  assert.equal(after.bind?.state, 'installed', JSON.stringify(after));
  assert.equal(after.dig, undefined, JSON.stringify(after));
  await run(
    page,
    'clear; pnpm ls -g --depth=0 2>/dev/null | grep -c "wasi-dig" | sed "s/^/digleft=/"; dig -v 2>&1 | grep -c "DiG 9" | sed "s/^/bindig=/"; for c in dig host nslookup; do command -v $c >/dev/null && echo "has-$c"; done; host localhost >/tmp/host.log 2>&1; echo "host=$?"; dig +short localhost >/tmp/dig.log 2>&1; echo "dig=$?"; echo done-$((40 + 2))'
  );
  await shows(page, 'done-42', 120000);
  const text = await screen(page);
  assert.match(text, /digleft=0/, text);
  assert.match(text, /bindig=1/, text);
  for (const command of ['dig', 'host', 'nslookup'])
    assert.match(text, new RegExp(`has-${command}`), text);
  assert.match(text, /host=0/, text);
  assert.match(text, /dig=0/, text);
  assert.deepEqual(page.errors, []);
});
