import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, ready, run, screen, shows, ui } from './bios.mjs';
import { launch } from './chrome.mjs';

async function opened(t) {
  const chrome = await launch();
  t.after(() => chrome.close());
  const page = await chrome.page(t);
  await ui(page);
  await page.init(() => {
    window.filesPanel = () => document.querySelector('slicc-app').dock.content('files').shadowRoot;
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const tmp = await root.getDirectoryHandle('tmp', { create: true });
      return tmp.getDirectoryHandle('picked', { create: true });
    };
  });
  return page;
}

async function said(page, command, mark) {
  await run(page, `clear; ${command}; echo ${mark}-$((40 + 2))`);
  await shows(page, `${mark}-42`);
  return (await screen(page)).replace(/\s+/g, ' ');
}

async function approve(page) {
  const [approval] = await page.until(() => {
    const list = document.querySelector('slicc-app').model.approvals.list();
    return list.length ? list : null;
  });
  await page.until((id) => {
    const find = (root) => {
      const found = root.querySelector('slicc-approvals');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && find(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const list = document.querySelector('slicc-app').model.approvals.list();
    if (!list.some((item) => item.id === id)) return true;
    find(document)
      ?.shadowRoot?.querySelector(`dialog[data-approval="${id}"] [data-action="once"]`)
      ?.click();
    return false;
  }, approval.id);
  return approval;
}

test('on a fresh profile /mnt is root’s 0755 and stays so after a cone’s sudo mkdir -p at umask 077, and a Files panel mount is the cone’s: it reads and writes it, nobody is refused, root writes, and the ejected mount point stays the cone’s', async (t) => {
  const page = await opened(t);
  await boot(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.users), 'enforce');

  await run(
    page,
    "clear; cd /tmp; sudo -u cone bash -c 'umask 077; sudo mkdir -p /mnt/x'; echo made=$?; stat -c 'at %n %a %U' /mnt /mnt/x; echo sudo-$((40 + 2))"
  );
  const approval = await approve(page);
  assert.equal(approval.command, '/usr/bin/mkdir -p /mnt/x');
  await shows(page, 'sudo-42');
  const made = (await screen(page)).replace(/\s+/g, ' ');
  assert.match(made, /made=0/);

  await page.until(() => !!window.filesPanel().querySelector('[data-action="mount-folder"]'));
  await page.evaluate(() =>
    window.filesPanel().querySelector('[data-action="mount-folder"]').click()
  );
  await page.until(() =>
    document.querySelector('slicc-app').model.files.mounts().includes('/mnt/picked')
  );
  const used = await said(
    page,
    "stat -c 'point %a %u %g' /mnt/picked; sudo -u cone sh -c 'echo from-cone > /mnt/picked/cone.txt && ls /mnt/picked'; echo cone=$?; sudo -u nobody sh -c 'echo x > /mnt/picked/nobody.txt'; echo nobody=$?; test -e /mnt/picked/nobody.txt || echo no-nobody-file; echo from-root > /mnt/picked/root.txt; echo root=$?",
    'used'
  );
  assert.match(used, /cone=0/);
  assert.match(used, /cone\.txt/);
  assert.match(used, /point 755 1000 1000/);
  assert.match(used, /Permission denied/);
  assert.doesNotMatch(used, /nobody=0/);
  assert.match(used, /no-nobody-file/);
  assert.match(used, /root=0/);
  const layout = await said(page, "stat -c 'at %n %a %U %G' /mnt /mnt/x", 'layout');
  assert.match(layout, /at \/mnt 755 root root/);
  assert.match(layout, /at \/mnt\/x 700 root root/);

  await page.until(
    () => !!window.filesPanel().querySelector('[data-action="eject"][data-path="/mnt/picked"]')
  );
  await page.evaluate(() =>
    window.filesPanel().querySelector('[data-action="eject"][data-path="/mnt/picked"]').click()
  );
  await page.until(() => document.querySelector('slicc-app').model.files.mounts().length === 0);
  assert.match(
    await said(page, "stat -c 'ejected %a %U %G' /mnt/picked", 'ejected'),
    /ejected 755 cone cone/
  );
  assert.deepEqual(page.errors, []);
});

test('a root /mnt others cannot search is set to 0755 once at the next boot, and an admin’s later chmod stays', async (t) => {
  const page = await opened(t);
  await boot(page);
  await said(page, 'mkdir -p /mnt; chmod 700 /mnt; rm -f /var/lib/slicc/mnt-mode', 'broken');
  await page.reload();
  await ready(page);
  const repaired = await said(
    page,
    "stat -c 'repaired %a %U' /mnt; test -s /var/lib/slicc/mnt-mode && echo marked",
    'repaired'
  );
  assert.match(repaired, /repaired 755 root/);
  assert.match(repaired, /marked/);

  await said(page, 'chmod 700 /mnt', 'admin');
  await page.reload();
  await ready(page);
  assert.match(await said(page, "stat -c 'kept %a %U' /mnt", 'kept'), /kept 700 root/);
  assert.deepEqual(page.errors, []);
});
