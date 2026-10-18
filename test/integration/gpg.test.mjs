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

const KEYS = [
  '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',
];
const RACE = [
  '#!/bin/bash',
  'home=$1',
  'mkdir -p "$home" && chmod 700 "$home"',
  'for i in $(seq 0 $((${#KEYS[@]} - 1))); do',
  '  gpg --homedir "$home" --batch --quiet --import /tmp/tide-key-$i.gpg 2>> /tmp/tide-race.err &',
  'done',
  'wait',
  'echo "$home holds $(gpg --homedir "$home" --batch --list-keys --with-colons 2>> /tmp/tide-race.err | grep -c ^pub)"',
].join('\n');

const terminal = (page) =>
  page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });

test('homescoop#712: six gpg imports at once into one homedir keep every key, three times over', async (t) => {
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
  const keys = KEYS.map((key, i) => `echo ${key} | base64 -d > /tmp/tide-key-${i}.gpg`).join('; ');
  const script = Buffer.from(`${RACE.replace('${#KEYS[@]}', String(KEYS.length))}\n`).toString(
    'base64'
  );
  await run(
    page,
    `clear; cd /; ${keys}; echo ${script} | base64 -d > /usr/local/bin/tide-race; chmod 755 /usr/local/bin/tide-race; rm -f /tmp/tide-race.err; for round in 1 2 3; do tide-race /root/tide-$round; done; echo "errors $(grep -ci -e error -e invalid /tmp/tide-race.err)"; echo raced-$((40 + 2))`
  );
  await shows(page, 'raced-42', 10 * 60 * 1000);
  const text = await terminal(page);
  for (const round of [1, 2, 3]) {
    assert.match(text, new RegExp(`/root/tide-${round} holds ${KEYS.length}\\b`), text);
  }
  assert.match(text, /errors 0/);
  assert.deepEqual(page.errors, []);
});
