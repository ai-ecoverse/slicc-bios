import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const INSTALL = 10 * 60 * 1000;

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

async function act(page, id, action) {
  await page.evaluate(
    ([id, action]) => {
      window.acted = undefined;
      document
        .querySelector('slicc-app')
        .model.updates.actPackage(id, action)
        .then(
          () => 'ok',
          (error) => error.message
        )
        .then((result) => {
          window.acted = result;
        });
    },
    [id, action]
  );
  await page.within(INSTALL, () => window.acted !== undefined);
  return page.evaluate(() => window.acted);
}

test('Node.js (jsh) installs from the catalog, runs node and a .jsh script, and removes cleanly', async (t) => {
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

  const result = await act(page, 'node', 'install');
  assert.equal(result, 'ok', (await row(page, 'node')).log);
  const installed = await row(page, 'node');
  assert.equal(installed.state, 'installed');
  assert.equal(installed.version, '0.2.0');

  await run(
    page,
    `clear; cd /home && node -e "const path = require('node:path'); console.log('joined', path.posix.join('a', 'b'))" && printf '%s\\n' 'import { readFileSync } from "node:fs";' 'console.log("jsh read", readFileSync("/home/hello.txt", "utf8").trim().length * 6);' > /home/read.jsh && echo greetings > /home/hello.txt && jsh /home/read.jsh`
  );
  await shows(page, 'joined a/b');
  await shows(page, 'jsh read 54');

  assert.equal(await act(page, 'node', 'remove'), 'ok');
  assert.equal((await row(page, 'node')).state, 'available');
  await run(page, 'command -v jsh || echo "no-jsh-$((6 * 7))"');
  await shows(page, 'no-jsh-42');
  assert.deepEqual(page.errors, []);
});
