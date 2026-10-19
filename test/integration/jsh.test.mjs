import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, run, shows } from './bios.mjs';
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

test('Node.js (jsh) installs from the catalog, runs node with CommonJS, ESM, fs.watch, v8.serialize, ESM class fields named like an import and a data: module importing a file: URL, and jsh with child_process, and removes cleanly', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'node')
  );
  const before = await row(page, 'node');
  assert.equal(before.state, 'available');
  assert.equal(before.label, 'Node.js (jsh)');

  const result = await actPackage(page, 'node', 'install');
  assert.equal(result, 'ok', (await row(page, 'node')).log);
  const installed = await row(page, 'node');
  assert.equal(installed.state, 'installed');
  assert.equal(installed.version, '0.45.4');

  await run(page, 'clear; echo "resolved $(command -v jsh) $(command -v node)"');
  await shows(page, 'resolved /usr/bin/jsh /usr/bin/node');

  await run(
    page,
    `clear; node -e "console.log('joined', require('node:path').posix.join('a', 'b').length * 14)"`
  );
  await shows(page, 'joined 42');
  await run(
    page,
    `clear; echo greetings > /home/hello.txt && printf '%s\\n' 'import { readFileSync } from "node:fs";' 'console.log("read", readFileSync("/home/hello.txt", "utf8").trim().length * 6);' > /home/read.mjs && node /home/read.mjs`
  );
  await shows(page, 'read 54');
  await run(
    page,
    `clear; mkdir -p /home/watched && node -e "const fs = require('node:fs'); const w = fs.watch('/home/watched', (event, name) => { console.log('watched-' + name.length * 7); w.close(); }); setTimeout(() => fs.writeFileSync('/home/watched/f.txt', 'x'), 200)"`
  );
  await shows(page, 'watched-35');
  await run(
    page,
    `clear; printf '%s\\n' 'const { readFileSync } = require("node:fs");' 'console.log("jsh read", readFileSync("/home/hello.txt", "utf8").trim().length * 6);' > /home/read.jsh && jsh /home/read.jsh`
  );
  await shows(page, 'jsh read 54');
  await run(
    page,
    `clear; printf '%s\\n' 'const { execFile } = require("node:child_process");' 'execFile("bash", ["-c", "exit 7"], (error) => console.log("child", error.code * 6));' > /home/child.jsh && jsh /home/child.jsh`
  );
  await shows(page, 'child 42');
  await run(
    page,
    `clear; node -e "console.log('sync', require('node:child_process').execSync('echo 6').toString().trim() * 7)"`
  );
  await shows(page, 'sync 42');
  await run(
    page,
    `clear; node -e "const v8 = require('node:v8'); const back = v8.deserialize(v8.serialize({ n: [6], m: new Map([['k', 7]]) })); console.log('v8', back.n[0] * back.m.get('k'))"`
  );
  await shows(page, 'v8 42');
  await run(
    page,
    `clear; printf '%s\\n' 'import { readFileSync } from "node:fs";' 'class Box { readFileSync = 6; }' 'console.log("field", Object.keys(new Box()).join(), new Box().readFileSync * 7);' > /home/fields.mjs && node /home/fields.mjs`
  );
  await shows(page, 'field readFileSync 42');
  await run(
    page,
    `clear; echo 'export default 6;' > /home/dep.mjs && printf '%s\\n' 'const src = "import x from " + JSON.stringify("file:///home/dep.mjs") + "; console.log(\\"data\\", x * 7);";' 'await import("data:text/javascript," + encodeURIComponent(src));' > /home/data.mjs && node /home/data.mjs`
  );
  await shows(page, 'data 42');

  assert.equal(await actPackage(page, 'node', 'remove'), 'ok');
  assert.equal((await row(page, 'node')).state, 'available');
  await run(page, 'clear; node -e 1 2>/dev/null || echo "no-node-$((6 * 7))"');
  await shows(page, 'no-node-42');
  assert.deepEqual(page.errors, []);
});

test('node writes and reads through a root symlink onto a tmpfs mount, the file is on the mount, and nothing is left under the mount point', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'node')
  );
  assert.equal(await actPackage(page, 'node', 'install'), 'ok');
  await run(
    page,
    "clear; mkdir -p /mnt/t5 /srv && mount -t tmpfs none /mnt/t5 && mkdir -p /mnt/t5/proj && ln -sfn /mnt/t5/proj /srv/proj && node -e \"const fs = require('fs'); fs.writeFileSync('/srv/proj/x.txt', 'through ' + (40 + 2)); console.log('node read', fs.readFileSync('/srv/proj/x.txt', 'utf8'))\"; echo mount has $(cat /mnt/t5/proj/x.txt); umount /mnt/t5; echo hidden:$(ls -A /mnt/t5)-$((40 + 2))"
  );
  await shows(page, '-42');
  const text = await page.evaluate(() => {
    const { dock } = document.querySelector('slicc-app');
    return dock.content(
      dock.api.panels.map((panel) => panel.id).findLast((id) => id.startsWith('terminal:'))
    ).screen.textContent;
  });
  assert.match(text, /node read through 42/);
  assert.match(text, /mount has through 42/);
  assert.match(text, /hidden:-42/);
  assert.deepEqual(page.errors, []);
});
