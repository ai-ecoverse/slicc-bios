import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';

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

test('an install from before users boots fresh under enforce: the agent works as cone, old files are locked, folders still mount', {
  timeout: 40 * 60 * 1000,
}, async (t) => {
  const chrome = await launch({ timeout: 120000, agent: true });
  const proxy = await fakeProxy({
    origin: new URL(chrome.url).origin,
    key: 'the-key',
    exports: { project: { 'hello.txt': 'hello from the host\n' } },
  });
  t.after(async () => {
    await proxy.close();
    await chrome.close();
  });
  const page = await chrome.page(t);
  await page.init(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const tmp = await root.getDirectoryHandle('tmp', { create: true });
      return tmp.getDirectoryHandle('picked', { create: true });
    };
  });
  const hash = (mode) =>
    `/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key', users: mode })}`;

  await page.goto(hash('off'));
  await ready(page, rootShell);
  await page.within(INSTALL, agentUp);
  await run(
    page,
    "clear; mkdir -p /home/.pi/agent /scoops/old/workspace /home/sprinkles /home/.slicc /mnt/p; echo '{\"servers\":{}}' > /home/.pi/agent/mcp.json; echo work > /scoops/old/workspace/notes.md; echo '<title>x</title>' > /home/sprinkles/x.shtml; echo '* * * * * cone echo hi' > /home/.slicc/crontab; echo mine > /home/notes.txt; mount -t hostfs -o ro project /mnt/p && echo populated-$((40 + 2))"
  );
  await shows(page, 'populated-42');
  await page.until(() =>
    document.querySelector('slicc-app').model.files.mounts().includes('/mnt/p')
  );

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
  await page.until(() =>
    document.querySelector('slicc-app').model.files.mounts().includes('/mnt/p')
  );

  await run(
    page,
    "clear; id cone; stat -c '%a %U %G' /home/cone; sudo -u cone cat /mnt/p/hello.txt; grep -c '^project /mnt/p hostfs ro.*uid=1000,gid=1000' /proc/mounts | sed 's/^/owned /'; ls -d /var/lib/slicc/agent/requests/cone && echo spool-ok; echo layout-$((40 + 2))"
  );
  await shows(page, 'layout-42', 5 * 60 * 1000);
  let text = await screen(page);
  assert.match(text, /uid=1000\(cone\).*\bsudo\b/);
  assert.match(text, /710 cone cone/);
  assert.match(text, /hello from the host/);
  assert.match(text, /owned 1/);
  assert.match(text, /spool-ok/);

  await run(
    page,
    "clear; sudo -u cone cat /home/.pi/agent/mcp.json; echo mcp=$?; sudo -u cone cat /scoops/old/workspace/notes.md; echo scoops=$?; cat /home/.pi/agent/mcp.json /scoops/old/workspace/notes.md /home/sprinkles/x.shtml /home/.slicc/crontab /home/notes.txt; stat -c '%a %U' /home/.pi/agent/mcp.json /home/notes.txt; echo old-$((40 + 2))"
  );
  await shows(page, 'old-42');
  text = await screen(page);
  assert.match(text, /mcp=1/);
  assert.match(text, /scoops=1/);
  for (const kept of ['{"servers":{}}', ' work ', '<title>x</title>', 'cone echo hi', ' mine ']) {
    assert.ok(text.includes(kept.trim()), kept);
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
    "clear; sudo -u cone sh -c 'echo from-cone > /mnt/picked/cone.txt' && cat /mnt/picked/cone.txt && echo wrote-$((40 + 2))"
  );
  await shows(page, 'wrote-42');
  assert.match(await screen(page), /from-cone/);

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
