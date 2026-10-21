import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  AGENT_BUDGET,
  actPackage,
  agentState,
  agentUp,
  boot,
  ready,
  rowSettled,
  run,
  screen,
  shows,
} from './bios.mjs';
import { offered } from './catalog.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000, agent: true });
const RSYNC = await offered('@ai-ecoverse/wasm-rsync');
const TREES = ['/opt/agent', '/opt/grammars', '/node_modules'];
const SCAN = 5 * 60 * 1000;
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

test('the shell runs as root: whoami, id, ls -l and ps name the users, and git works in a repo', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  assert.match(await screen(page), /slicc:\/home# /);
  await agentUp(page);
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
  assert.match(text, /(^|\s)\/usr\/local\/bin\/agent(\s|$)/);
  assert.doesNotMatch(text, /\/share\/pnpm\/(bin\/)?agent/);

  await rowSettled(page, 'grammars');
  await run(
    page,
    `clear; for d in ${TREES.join(' ')}; do echo "unreadable $d $(find $d ! -perm -o=r | wc -l) $(find $d -type d ! -perm -o=x | wc -l)"; done; echo "checked $((6 * 7))"`
  );
  const scanning = Date.now();
  for (const tree of TREES) {
    const begun = Date.now();
    await shows(page, `unreadable ${tree} `, SCAN).catch(async (error) => {
      throw new Error(
        `find printed nothing for ${tree} within ${Math.round((Date.now() - begun) / 1000)} s (${Math.round((Date.now() - scanning) / 1000)} s since the scan began): ${error.message}\n${await screen(page)}`
      );
    });
    console.log(`scanned ${tree} in ${Math.round((Date.now() - begun) / 1000)} s`);
    const shown = await screen(page);
    assert.match(shown, new RegExp(`unreadable ${tree} 0 0`), shown);
  }
  await shows(page, 'checked 42');

  assert.equal(await actPackage(page, 'git'), 'ok');
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
  await page.evaluate(async (version) => {
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
      JSON.stringify({ dependencies: { '@ai-ecoverse/wasm-rsync': version } })
    );
    await put(
      `${old}/node_modules/@ai-ecoverse/wasm-rsync/package.json`,
      JSON.stringify({ name: '@ai-ecoverse/wasm-rsync', version })
    );
  }, RSYNC);
  await page.reload();
  await ready(page);
  await page
    .within(AGENT_BUDGET, () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === 'rsync' && item.state === 'installed')
    )
    .catch(async (error) => {
      throw new Error(
        `${error.message}\nrsync waits for the pnpm store behind the agent's install\n${await agentState(page)}`
      );
    });
  assert.equal((await row(page, 'rsync')).version, RSYNC);
  assert.equal((await row(page, 'git')).state, 'available');
  await run(
    page,
    `rsync --version | head -1 | grep -c "version ${RSYNC.split('-')[0]}" | sed "s/^/rsync ran /"`
  );
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

const readOpfs = (page, path) =>
  page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/');
    const name = parts.pop();
    try {
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }, path);

test('a schedule in a cone’s ~/.slicc/crontab from an older agent moves into the cone’s kernel crontab and fires as a cron lick', {
  timeout: 35 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await agentUp(page);
  await run(
    page,
    "clear; mkdir -p /home/cone/.slicc && printf '%s\\n' '* * * * * hello cone ping from the old schedule' > /home/cone/.slicc/crontab && chown -R cone:cone /home/cone/.slicc && echo \"wrote $((6 * 7))\""
  );
  await shows(page, 'wrote 42');
  const state = async () => ({
    table: await readOpfs(page, 'var/spool/cron/crontabs/cone'),
    old: await readOpfs(page, 'home/cone/.slicc/crontab'),
    migrated: await readOpfs(page, 'home/cone/.slicc/crontab.migrated'),
    chat: await page.evaluate(() => {
      const { agent } = document.querySelector('slicc-app').model;
      return JSON.stringify(agent.messages(agent.active())).slice(-2000);
    }),
  });
  const deadline = Date.now() + 4 * 60 * 1000;
  let seen = await state();
  while (
    !(seen.table?.includes('agent send cone') && seen.chat.includes('ping from the old schedule'))
  ) {
    if (Date.now() > deadline)
      throw new Error(
        `the old schedule never fired as a cron lick within 240 s: ${JSON.stringify(seen)}\n${await agentState(page)}\n${page.console.slice(-15).join('\n')}`
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    seen = await state();
  }
  assert.match(seen.table, /# name: hello/);
  assert.equal(seen.old, null);
  assert.match(seen.migrated, /hello cone ping from the old schedule/);
  assert.match(seen.chat, /cron/);
  assert.deepEqual(page.errors, []);
});
