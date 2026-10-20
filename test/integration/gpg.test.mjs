import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { actPackage, boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const GNUPG = JSON.parse(
  await readFile(new URL('../../src/packages/optional/package.json', import.meta.url), 'utf8')
).dependencies['@ai-ecoverse/wasix-gnupg'];

const KEY =
  'mDMEatLmsRYJKwYBBAHaRw8BAQdAiDCbQOSC0Xc6rQkWqIujObTt18i6mynEBwO/U3nZjBG0GnRpZGUxIDx0aWRlMUBleGFtcGxlLnRlc3Q+iK8EExYKAFcWIQTba55gObOBN7QIhcH1JvwrzalrzgUCatLmsRsUgAAAAAAEAA5tYW51MiwyLjUrMS4xMiwwLDMCGwMFCwkIBwICIgIGFQoJCAsCBBYCAwECHgcCF4AACgkQ9Sb8K82pa87QjgEAl/hGXBUUqAiv/m4jdJmrSN77lGGkMHtjf8fFjIhsd2MBAI0TmPzv3oYpbKL5LioOo17ejCv4ksiBDlJnG3BMDAwF';

const terminal = (page) =>
  page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });

test('gpg installs from the catalog, imports a key into a homedir and lists it', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'gpg')
  );
  assert.equal(await actPackage(page, 'gpg', 'install'), 'ok');
  assert.equal(
    await page.evaluate(
      () =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .find((item) => item.id === 'gpg').version
    ),
    GNUPG
  );
  await run(
    page,
    `clear; cd /; echo ${KEY} | base64 -d > /tmp/tide-key.gpg; rm -rf /root/tide && mkdir -p /root/tide && chmod 700 /root/tide && gpg --homedir /root/tide --batch --quiet --import /tmp/tide-key.gpg; echo "keys $(gpg --homedir /root/tide --batch --list-keys --with-colons | grep -c ^pub)"; echo imported-$((40 + 2))`
  );
  await shows(page, 'imported-42', 5 * 60 * 1000);
  assert.match(await terminal(page), /keys 1\b/);
  assert.deepEqual(page.errors, []);
});
