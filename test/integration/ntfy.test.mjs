import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { actPackage, boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeNtfy } from './fake-ntfy.mjs';

const HOST = 'ntfy.example.test';
const QUIET = 50;

const ntfy = await fakeNtfy({ host: HOST });
const chrome = await launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
const url = `http://${HOST}:${ntfy.port}`;
after(async () => {
  await ntfy.close();
  await chrome.close();
});

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

const read = (page, path) =>
  page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }, path);

async function lines(page, path, count, ms, why) {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = (await read(page, path)) ?? '';
    const found = text.split('\n').filter(Boolean);
    if (found.length >= count) return found;
    if (Date.now() > deadline)
      throw new Error(
        `${why}: ${found.length} of ${count} lines in /${path} after ${ms / 1000} s\n${text}\nscreen:\n${await screen(page)}\nrequests:\n${JSON.stringify(ntfy.requests.slice(-10))}`
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function until(check, ms, why) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`${why} within ${ms / 1000} s: ${JSON.stringify(ntfy.requests.slice(-10))}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const json = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('ntfy installs from the catalog and talks to an ntfy server from seven: publish, poll and a streaming handler', () => {
  let page;
  let finish;
  after(() => finish?.());
  before(async () => {
    page = await chrome.page({
      name: 'ntfy',
      filePath: import.meta.filename,
      after: (fn) => {
        finish = fn;
      },
    });
    await boot(page);
  });

  test('the catalog offers ntfy, and it installs and runs', async () => {
    await page.until(() =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'ntfy' && item.offered && !item.registry)
    );
    const listed = await row(page, 'ntfy');
    assert.equal(listed.state, 'available');
    assert.equal(listed.label, 'ntfy');
    assert.deepEqual(listed.commands, ['ntfy']);
    assert.equal(await actPackage(page, 'ntfy', 'install'), 'ok', (await row(page, 'ntfy')).log);
    const installed = await row(page, 'ntfy');
    assert.equal(installed.state, 'installed');
    assert.equal(installed.version, installed.offered);
    await run(page, 'clear; ntfy --help > /dev/null 2>&1; echo "help $((40 + $?))"');
    await shows(page, 'help 4');
    assert.match(await screen(page), /help 40/);
  });

  test('ntfy pub, then ntfy sub --poll --since all, round-trips a message', async () => {
    await run(
      page,
      `clear; ntfy pub --title Greeting ${url}/round 'hello from seven' > /home/ntfy-pub.json 2>&1; echo "published $((40 + $?))"; ntfy sub --poll --since all ${url}/round > /home/ntfy-poll.json 2>&1; echo "polled $((40 + $?))"`
    );
    await shows(page, 'polled 4');
    const text = await screen(page);
    assert.match(text, /published 40/, text);
    assert.match(text, /polled 40/, text);
    const sent = ntfy.messages.filter((message) => message.topic === 'round');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message, 'hello from seven');
    assert.equal(sent[0].title, 'Greeting');
    const polled = json(await read(page, 'home/ntfy-poll.json')).filter(
      (message) => message.event === 'message'
    );
    assert.deepEqual(
      polled.map(({ id, message, title }) => ({ id, message, title })),
      [{ id: sent[0].id, message: 'hello from seven', title: 'Greeting' }]
    );
  });

  test(`a streaming ntfy sub runs its command once per message, in order, with NTFY_MESSAGE, NTFY_RAW and NTFY_TITLE, and keeps running on its one stream through ${QUIET} s of quiet`, {
    timeout: 6 * 60 * 1000,
  }, async () => {
    await run(
      page,
      `clear; rm -f /home/ntfy-handled; ntfy sub ${url}/stream 'printf "%s %s %s\\n" "$NTFY_MESSAGE" "$(printf %s "$NTFY_RAW" | jq -r .id)" "$NTFY_TITLE" >> /home/ntfy-handled' > /home/ntfy-sub.log 2>&1 & echo "subscribed $((40 + 2))"`
    );
    await shows(page, 'subscribed 42');
    await until(() => ntfy.streams('stream') === 1, 60000, 'ntfy sub never opened its stream');
    const sent = ['one', 'two', 'three'].map((message) =>
      ntfy.publish('stream', { message, title: `title-${message}` })
    );
    assert.deepEqual(
      await lines(page, 'home/ntfy-handled', 3, 60000, 'the command ran'),
      sent.map(({ id, message }) => `${message} ${id} title-${message}`)
    );
    const late = await new Promise((resolve) =>
      setTimeout(
        () => resolve(ntfy.publish('stream', { message: 'four', title: 'title-four' })),
        QUIET * 1000
      )
    );
    const all = await lines(page, 'home/ntfy-handled', 4, 60000, 'the command after the quiet ran');
    assert.equal(all[3], `four ${late.id} title-four`);
    assert.equal(ntfy.opened('stream'), 1, 'the stream was never reconnected');
    await run(
      page,
      'clear; echo "running $(pgrep -f "ntfy sub" | wc -l)"; pkill -f "ntfy sub"; echo "stopped $((40 + 2))"'
    );
    await shows(page, 'stopped 42');
    assert.match(await screen(page), /running [1-9]/);
    assert.deepEqual(page.errors, []);
  });
});
