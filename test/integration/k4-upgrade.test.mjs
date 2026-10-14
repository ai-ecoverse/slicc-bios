import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const INSTALL = 15 * 60 * 1000;
const rootShell = ['slicc:/home# '];

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return '';
    }
  }, path);
}

const agentUp = () => document.querySelector('slicc-app').model.updates.ready();

test('an install from before users boots fresh under enforce: the agent works as cone, old files are locked, a picked folder is the cone’s', {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  const chrome = await launch({ timeout: 120000, agent: true });
  t.after(() => chrome.close());
  const page = await chrome.page(t);
  await page.init(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const tmp = await root.getDirectoryHandle('tmp', { create: true });
      return tmp.getDirectoryHandle('picked', { create: true });
    };
  });
  const hash = (mode) => `/#users=${mode}`;

  await page.goto(hash('off'));
  await ready(page, rootShell);
  await page.within(INSTALL, agentUp);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const put = async (path, data) => {
      const names = path.split('/');
      const name = names.pop();
      let dir = root;
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(data);
      await writable.close();
    };
    await put('home/.pi/agent/mcp.json', '{"servers":{}}\n');
    await put('scoops/old/workspace/notes.md', 'work\n');
    await put('home/sprinkles/x.shtml', '<title>x</title>\n');
    await put('home/.slicc/crontab', '* * * * * cone echo hi\n');
    await put('home/notes.txt', 'mine\n');
  });
  await run(
    page,
    'clear; ls /home/.pi/agent/mcp.json /scoops/old/workspace/notes.md; echo populated-$((40 + 2))'
  );
  await shows(page, 'populated-42');
  assert.doesNotMatch(await screen(page), /No such file/);

  await page.goto(hash('enforce'));
  await ready(page, rootShell);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.users), 'enforce');
  await page.within(INSTALL, agentUp);
  const agentRow = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .find((item) => item.id === 'agent')
  );
  assert.notEqual(agentRow.state, 'failed', agentRow.error);

  await run(
    page,
    "clear; id cone; stat -c '%a %U %G' /home/cone; ls -d /var/lib/slicc/agent/requests/cone && echo spool-ok; echo layout-$((40 + 2))"
  );
  await shows(page, 'layout-42', 5 * 60 * 1000);
  let text = await screen(page);
  assert.match(text, /uid=1000\(cone\).*\bsudo\b/);
  assert.match(text, /710 cone cone/);
  assert.match(text, /spool-ok/);

  await run(
    page,
    "clear; sudo -u cone cat /home/.pi/agent/mcp.json; echo mcp=$?; sudo -u cone cat /scoops/old/workspace/notes.md; echo scoops=$?; cat /home/.pi/agent/mcp.json /scoops/old/workspace/notes.md /home/sprinkles/x.shtml /home/.slicc/crontab /home/notes.txt; stat -c '%a %U' /home/.pi/agent/mcp.json /home/notes.txt; echo old-$((40 + 2))"
  );
  await shows(page, 'old-42');
  text = await screen(page);
  assert.match(text, /mcp=1/);
  assert.match(text, /scoops=1/);
  for (const kept of ['{"servers":{}}', 'work', '<title>x</title>', 'cone echo hi', 'mine']) {
    assert.ok(text.includes(kept), `${kept} in ${text}`);
  }
  assert.match(text, /600 root/);
  assert.match(text, /644 root/);
  const marker = await read(page, 'var/lib/slicc/legacy-locked');
  assert.match(marker, /^\d{4}-\d\d-\d\dT/);

  const picked = await page.evaluate(() =>
    document.querySelector('slicc-app').model.files.mountFolder()
  );
  assert.equal(picked, '/mnt/picked');
  await run(
    page,
    'clear; while read -r src at type opts rest; do [ "$at" = /mnt/picked ] && [[ $opts == *uid=1000,gid=1000* ]] && echo owned 1; done < /proc/mounts; sudo -u cone sh -c \'echo from-cone > /mnt/picked/cone.txt\' && cat /mnt/picked/cone.txt && echo wrote-$((40 + 2))'
  );
  await shows(page, 'wrote-42');
  assert.match(await screen(page), /from-cone/);
  assert.match(await screen(page), /owned 1/);

  await page.reload();
  await ready(page, rootShell);
  await page.within(INSTALL, agentUp);
  assert.equal(await read(page, 'var/lib/slicc/legacy-locked'), marker);
  const denials = (await read(page, 'var/log/slicc/denials.log'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const own = denials.filter(
    (line) =>
      line.tag?.includes('"kind":"agent"') &&
      /^\/(\.slicc|var\/lib\/slicc\/agent|home\/cone)(\/|$)/.test(line.path)
  );
  assert.deepEqual(own, []);
  assert.deepEqual(page.errors, []);
});
