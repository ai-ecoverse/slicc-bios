import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000, agent: true });
const INSTALL = 15 * 60 * 1000;
after(() => chrome.close());

const color = (page, value) =>
  page.evaluate((value) => {
    const app = document.querySelector('slicc-app');
    if (app.color !== value) app.toggleColor();
  }, value);

async function narrow(page, show) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await show();
}

async function wide(page) {
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
}

const row = (page, id) =>
  page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .find((item) => item.id === id),
    id
  );

test('the shell runs as root: whoami, id, ls -l and ps name the users, and git works in a repo', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.match(await screen(page), /slicc:\/home# /);
  await page.within(INSTALL, () => document.querySelector('slicc-app').model.updates.ready());
  await run(
    page,
    'clear; whoami; id; ls -ld /root /home; ps -o user,pid,comm; which agent; echo "listed $((6 * 7))"'
  );
  await shows(page, 'listed 42');
  const text = await screen(page);
  assert.match(text, /^\s*root\b/m);
  assert.match(text, /uid=0\(root\) gid=0\(root\)/);
  assert.match(text, /drwx------\s+\d+\s+root\s+root\b/);
  assert.match(text, /root\s+\d+\s+bash/);
  assert.match(text, /\/usr\/local\/share\/pnpm\/(bin\/)?agent/);

  const installed = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.actPackage('git', 'install')
      .then(
        () => 'ok',
        (error) => error.message
      )
  );
  assert.equal(installed, 'ok');
  await run(
    page,
    'mkdir -p /home/repo && cd /home/repo && git init -q && echo hi > notes.txt && git status --short; echo "git says $?"'
  );
  await shows(page, 'git says 0');
  assert.match(await screen(page), /\?\? notes\.txt/);
  assert.doesNotMatch(await screen(page), /dubious ownership/);

  await color(page, 'light');
  await page.screenshot(new URL('root-shell-light.png', page.dir));
  await color(page, 'dark');
  await page.screenshot(new URL('root-shell-dark.png', page.dir));
  await color(page, 'light');
  await narrow(page, () =>
    page.evaluate(() => {
      const app = document.querySelector('slicc-app');
      const id = app.dock.api.panels
        .map((panel) => panel.id)
        .findLast((panel) => panel.startsWith('terminal:'));
      app.dock.api.getPanel(id)?.api.setActive();
    })
  );
  await page.screenshot(new URL('root-shell-420.png', page.dir));
  await wide(page);
  assert.deepEqual(page.errors, []);
});

test('optional packages installed before the upgrade come back for root, in the new global directory', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'rsync')
  );
  await page.evaluate(async () => {
    const put = async (path, text) => {
      let dir = await navigator.storage.getDirectory();
      const names = path.split('/');
      const name = names.pop();
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    };
    const old = 'home/.local/share/pnpm/global/v11/1-before';
    await put(
      `${old}/package.json`,
      JSON.stringify({ dependencies: { '@ai-ecoverse/wasm-rsync': '3.4.4-3' } })
    );
    await put(
      `${old}/node_modules/@ai-ecoverse/wasm-rsync/package.json`,
      JSON.stringify({ name: '@ai-ecoverse/wasm-rsync', version: '3.4.4-3' })
    );
  });
  await page.reload();
  await ready(page);
  await page.within(300000, () =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'rsync' && item.state === 'installed')
  );
  assert.equal((await row(page, 'rsync')).version, '3.4.4-3');
  assert.equal((await row(page, 'git')).state, 'available');
  await run(page, 'rsync --version | head -1 | grep -c "version 3.4.4" | sed "s/^/rsync ran /"');
  await shows(page, 'rsync ran 1');

  const show = async () => {
    await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
    await page.until(
      () =>
        !!document
          .querySelector('slicc-app')
          .dock.content('updates')
          ?.shadowRoot?.querySelector('li[data-id="rsync"][data-state="installed"]')
    );
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .dock.content('updates')
        .shadowRoot.querySelector('section[data-section="packages"]')
        .scrollIntoView({ block: 'start' })
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  };
  await color(page, 'light');
  await show();
  await page.screenshot(new URL('upgraded-packages-light.png', page.dir));
  await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      .shadowRoot.querySelector('li[data-id="rsync"]')
      .scrollIntoView({ block: 'center' })
  );
  await page.screenshot(new URL('upgraded-rsync-light.png', page.dir));
  await color(page, 'dark');
  await page.screenshot(new URL('upgraded-rsync-dark.png', page.dir));
  await color(page, 'light');
  await narrow(page, show);
  await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      .shadowRoot.querySelector('li[data-id="rsync"]')
      .scrollIntoView({ block: 'center' })
  );
  await page.screenshot(new URL('upgraded-rsync-420.png', page.dir));
  await wide(page);
  assert.deepEqual(page.errors, []);
});
