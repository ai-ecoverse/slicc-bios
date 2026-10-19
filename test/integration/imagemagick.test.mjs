import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { actPackage, boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const AVIF = (await readFile(new URL('fixtures/imagemagick/tide.avif', import.meta.url))).toString(
  'base64'
);

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
  assert.equal(row.version, '7.1.2-34-9.1');
}

test('ImageMagick converts a PNG to JPEG and identifies it, resizes with convert and mogrify, and decodes an AVIF', async (t) => {
  const page = await chrome.page(t);
  await installed(page);
  await run(
    page,
    `clear; rm -rf /tmp/im && mkdir -p /tmp/im && cd /tmp/im && magick -size 40x20 xc:'#e03c31' tide.png && magick tide.png tide.jpg; echo jpg=$?; identify -format 'id=%m %wx%h\\n' tide.jpg; convert tide.png -resize 50% half.png; identify -format 'half=%wx%h\\n' half.png; mogrify -resize 200% half.png; identify -format 'mog=%wx%h\\n' half.png; echo ${AVIF} | base64 -d > tide.avif; identify -format 'avif=%m %wx%h\\n' tide.avif; magick tide.avif -format 'px=%[pixel:p{1,1}]\\n' info:; magick tide.avif back.png && identify -format 'back=%m %wx%h\\n' back.png; echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await screen(page);
  assert.match(text, /jpg=0/);
  assert.match(text, /id=JPEG 40x20/);
  assert.match(text, /half=20x10/);
  assert.match(text, /mog=40x20/);
  assert.match(text, /avif=(AVIF|HEIC) 32x16/);
  assert.match(text, /px=srgb\(224,60,49\)/);
  assert.match(text, /back=PNG 32x16/);
  assert.deepEqual(page.errors, []);
});

test('a failed write leaves the existing target as it was, with no temp file behind (homescoop#562), and sudo for magick is offered once, never always', async (t) => {
  const page = await chrome.page(t);
  await installed(page);
  await run(
    page,
    `clear; rm -rf /tmp/iw && mkdir -p /tmp/iw && cd /tmp/iw && magick -size 10x10 xc:blue keep.webp && cp keep.webp keep.orig && magick -size 20000x10 xc:red keep.webp; echo fail=$?; cmp keep.webp keep.orig && echo intact-$((1 + 1)); echo temps=$(ls -a | grep -c '~$'); echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await screen(page);
  assert.match(text, /fail=1/);
  assert.match(text, /intact-2/);
  assert.match(text, /temps=0/);
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
