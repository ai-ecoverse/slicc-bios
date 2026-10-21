import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, run, screen, shows } from './bios.mjs';
import { offered } from './catalog.mjs';
import { launch } from './chrome.mjs';

const MAGICK = await offered('@ai-ecoverse/wasm-imagemagick-heif');

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

async function installed(page) {
  await boot(page);
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'imagemagick'),
    null
  );
  assert.equal(await actPackage(page, 'imagemagick', 'install'), 'ok');
  const row = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .find((item) => item.id === 'imagemagick')
  );
  assert.equal(row.version, MAGICK);
}

test('ImageMagick installs from the catalog, makes a PNG, converts it to JPEG and identifies it', async (t) => {
  const page = await chrome.page(t);
  await installed(page);
  await run(
    page,
    `clear; rm -rf /tmp/im && mkdir -p /tmp/im && cd /tmp/im && magick -size 40x20 xc:'#e03c31' tide.png && magick tide.png tide.jpg; echo jpg=$?; identify -format 'id=%m %wx%h\\n' tide.jpg; echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await screen(page);
  assert.match(text, /jpg=0/);
  assert.match(text, /id=JPEG 40x20/);
  assert.deepEqual(page.errors, []);
});

test('sudo for magick writing under /etc is offered once, never always, since magick writes files', async (t) => {
  const page = await chrome.page(t);
  await installed(page);
  const command = 'magick /etc/group /etc/group';
  await run(page, `clear; cd /tmp; sudo -u cone sudo ${command}; echo asked-$((40 + 2))`);
  const [asked] = await page.within(60000, () => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  assert.ok(asked.command.endsWith(`/${command}`), asked.command);
  assert.equal(asked.always, false, asked.command);
  await page.evaluate(
    (id) => document.querySelector('slicc-app').model.approvals.decide(id, 'deny'),
    asked.id
  );
  await shows(page, 'asked-42', 60000);
  assert.deepEqual(page.errors, []);
});
