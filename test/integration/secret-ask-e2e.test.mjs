import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startFakeVault } from './fake-vault.mjs';

const chrome = await launch({ vault: false });
after(() => chrome.close());

const secrets = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.approvals.list()
      .filter((item) => item.kind === 'secret')
  );

async function waitFor(check) {
  for (let tries = 0; tries < 200 && !(await check()); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return check();
}

test('sealed ask from a terminal opens spectrum’s secret dialog with the vault’s frame: the typed value comes back to the program, Deny exits 1, and the session then rests', async (t) => {
  const fake = await startFakeVault({ secrets: [] });
  t.after(() => fake.close());
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) localStorage.setItem('slicc-os.vault-origin', ${JSON.stringify(fake.origin)}); }`
  );
  await boot(page);
  await page.until(
    () => document.querySelector('slicc-app').model.vault?.availability() === 'ready'
  );
  assert.equal(await page.evaluate(() => globalThis.sliccSecretApprovals), undefined);

  await run(page, 'clear; V=$(sealed ask TIDE_TOKEN --reveal); echo "GOT-$V-$?"');
  assert.ok(await waitFor(async () => (await secrets(page)).length === 1));
  const [entered] = await secrets(page);
  assert.deepEqual(
    [entered.mode, entered.requester.kind, entered.requester.where, entered.process.exe],
    ['enter', 'user', 'a terminal', '/usr/bin/sealed']
  );
  assert.ok(
    await waitFor(() =>
      fake.log.some(
        (entry) => entry.role === 'value' && entry.op === 'value' && entry.request === entered.id
      )
    ),
    'spectrum’s dialog loaded the vault’s frame for the request'
  );
  fake.set({ typed: { request: entered.id, value: 'tide-e2e-value-91ab' } });
  await shows(page, 'GOT-tide-e2e-value-91ab-0');
  assert.ok(await waitFor(async () => (await secrets(page)).length === 0));

  await run(page, 'clear; sealed ask TIDE_TOKEN --reveal; echo "DENIED-$?"');
  assert.ok(await waitFor(async () => (await secrets(page)).length === 1));
  const [revealing] = await secrets(page);
  assert.equal(revealing.mode, 'reveal');
  await page.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'deny'),
    revealing.id
  );
  await shows(page, 'DENIED-1');

  await run(page, 'clear; sealed ask TIDE_TOKEN; echo "RESTING-$?"');
  await shows(page, 'RESTING-3');
  assert.match(await screen(page), /another request was just dismissed/);
  assert.ok(!page.console.some((line) => line.includes('tide-e2e-value-91ab')));
  assert.deepEqual(page.errors, []);
});
