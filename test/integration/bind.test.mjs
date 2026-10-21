import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';

const chrome = await launch({ timeout: 120000, intercept: [] });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

const DIG = '@ai-ecoverse/wasi-dig';
const BIND = '@ai-ecoverse/wasix-bind';

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

async function sh(page, line, user = 'root') {
  await page.until(() => typeof globalThis.sliccKernelClient === 'function');
  return page.evaluate(
    async ([line, user]) => {
      globalThis.bindClient ??= await globalThis.sliccKernelClient();
      const options = user === 'root' ? { cwd: '/' } : { cwd: `/home/${user}`, user };
      const { status, stdout, stderr } = await globalThis.bindClient.run(
        ['bash', '-c', line],
        options
      );
      return `${stdout ?? ''}${stderr ?? ''}status=${status}`;
    },
    [line, user]
  );
}

async function rootDig(page) {
  await run(
    page,
    `clear; pnpm add -g ${DIG} > /tmp/dig-add.log 2>&1; echo "dig-added=$?-$((40 + 2))"`
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
}

test('installing the BIND tools over an earlier dig removes wasi-dig first, so dig, host and nslookup are BIND’s, and they look up names with no server argument through the kernel’s DNS stub (homescoop#1282)', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  registry.reset();
  const page = await chrome.page(t);
  await boot(page);
  await rootDig(page);
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

test('a cone’s own wasi-dig doesn’t block root’s install of the BIND tools, and stays the cone’s', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  registry.reset();
  const page = await chrome.page(t);
  await page.init('() => { globalThis.sliccKernelDebug = true; }');
  await page.goto('/#users=enforce');
  await ready(page, ['slicc:/home# ']);
  const added = await sh(page, `pnpm add -g ${DIG} >/dev/null 2>&1; echo dig=$?`, 'cone');
  assert.match(added, /dig=0/, added);
  assert.equal(await actPackage(page, 'bind', 'install'), 'ok');
  const theirs = await sh(
    page,
    'pnpm ls -g --depth=0 2>/dev/null | grep -c wasi-dig | sed "s/^/conedig=/"; dig -v 2>&1 | grep -c "DiG 9" | sed "s/^/bind=/"',
    'cone'
  );
  assert.match(theirs, /conedig=1/, theirs);
  const root = await sh(page, 'dig -v 2>&1 | grep -c "DiG 9" | sed "s/^/rootbind=/"');
  assert.match(root, /rootbind=1/, root);
  assert.deepEqual(page.errors, []);
});

test('a BIND tools install that fails leaves the earlier wasi-dig installed, with dig still on PATH', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  registry.reset();
  const page = await chrome.page(t);
  await boot(page);
  await rootDig(page);
  registry.only = /\/wasix-bind-[^/]+\.tgz$/;
  registry.tarballs = 404;
  const result = await actPackage(page, 'bind', 'install');
  registry.tarballs = 0;
  registry.only = null;
  assert.match(result, /^Couldn't install BIND tools/, result);
  const settled = await page
    .within(60000, () => {
      const dig = document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === 'dig');
      return dig?.state === 'installed' ? dig : null;
    })
    .catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify(await rows(page))}`);
    });
  assert.equal(settled.state, 'installed');
  await run(
    page,
    'clear; pnpm ls -g --depth=0 2>/dev/null | grep -c "wasi-dig" | sed "s/^/digback=/"; command -v dig >/dev/null && echo has-dig; echo done-$((40 + 2))'
  );
  await shows(page, 'done-42', 120000);
  const text = await screen(page);
  assert.match(text, /digback=1/, text);
  assert.match(text, /has-dig/, text);
  assert.deepEqual(page.errors, []);
});
