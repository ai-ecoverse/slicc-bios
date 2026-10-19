import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { crc32 } from 'node:zlib';
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

function archive(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 30, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
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

test('unzip refuses an entry whose name is not UTF-8 with exit 50 and lists it, never extracting it under a changed name (homescoop#1174)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await install(page, 'zip', '3.0.0-7');
  const zip = archive([
    [Buffer.from('ok.txt'), 'fine\n'],
    [Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]), 'latin\n'],
  ]).toString('base64');
  await run(
    page,
    `clear; rm -rf /tmp/zb && mkdir -p /tmp/zb && cd /tmp/zb && echo ${zip} | base64 -d > old.zip && echo listed=$(unzip -Z1 old.zip | wc -l); unzip -q old.zip -d out; echo unzip=$?; echo "files=[$(ls out | tr '\\n' ,)]"; echo ok=$(cat out/ok.txt); echo done-$((40 + 2))`
  );
  await shows(page, 'done-42', 5 * 60 * 1000);
  const text = await screen(page);
  assert.match(text, /unzip=50/);
  assert.match(text, /Illegal byte sequence/);
  assert.match(text, /listed=2/);
  assert.match(text, /files=\[ok\.txt,\]/);
  assert.match(text, /ok=fine/);
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
