import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

async function install(page, id, version) {
  await page.until(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id),
    id
  );
  assert.equal(await actPackage(page, id, 'install'), 'ok');
  assert.equal((await row(page, id)).version, version);
}

test('zip packs a tree and unzip gives it back unchanged, and zipinfo lists it', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await install(page, 'zip', '3.0.0-7');
  await run(
    page,
    `clear; rm -rf /tmp/zt && mkdir -p /tmp/zt/src/sub && cd /tmp/zt && printf 'tide %s\\n' 1 2 3 > src/a.txt && head -c 3000 /dev/urandom > src/sub/b.bin && zip -qr a.zip src; echo zip=$?; unzip -q a.zip -d out; echo unzip=$?; diff -r src out/src && echo same-$((0))-tree; echo "entries=[$(zipinfo -1 a.zip | sort | tr '\\n' ,)]"; echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await screen(page);
  assert.match(text, /zip=0/);
  assert.match(text, /unzip=0/);
  assert.match(text, /same-0-tree/);
  assert.match(text, /entries=\[src\/,src\/a\.txt,src\/sub\/,src\/sub\/b\.bin,\]/);
  assert.deepEqual(page.errors, []);
});

test('xxd dumps a file and xxd -r gives it back byte for byte', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await install(page, 'xxd', '9.2.1192-3');
  await run(
    page,
    `clear; rm -rf /tmp/xt && mkdir -p /tmp/xt && cd /tmp/xt && head -c 4096 /dev/urandom > r.bin && printf '\\000\\377tide\\n' >> r.bin && xxd r.bin > r.hex; echo xxd=$?; xxd -r r.hex > back.bin; echo rev=$?; cmp r.bin back.bin && echo identical-$((1 + 1)); echo first=$(printf 'AB' | xxd -p); echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await screen(page);
  assert.match(text, /xxd=0/);
  assert.match(text, /rev=0/);
  assert.match(text, /identical-2/);
  assert.match(text, /first=4142/);
  assert.deepEqual(page.errors, []);
});

test('sudo for xxd writing under /etc is offered once, never always, since xxd writes files', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await install(page, 'xxd', '9.2.1192-3');
  const command = 'xxd -r /etc/group /etc/group';
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
