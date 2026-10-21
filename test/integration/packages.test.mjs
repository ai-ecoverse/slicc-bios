import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { fakeCatalog } from './fake-catalog.mjs';

const chrome = await launch({ timeout: 120000, intercept: [] });
const registry = await fakeCatalog(chrome.cdp);
after(() => chrome.close());

const XXD = '@ai-ecoverse/wasm-xxd';
const RSYNC = '@ai-ecoverse/wasm-rsync';
const REGISTRY = 'https://registry.npmjs.org/';
const doc = async (name, version) =>
  JSON.parse(await download(`${REGISTRY}${name}/${encodeURIComponent(version)}`));

function offer(latest) {
  const catalog = {
    [XXD]: { id: 'xxd', label: 'xxd', notes: ['Hex dumps of any file.'] },
    [RSYNC]: { id: 'rsync', label: 'rsync', requires: ['xxd'] },
  };
  registry.reset();
  for (const [name, version] of Object.entries(latest)) registry.latest.set(name, version);
  chrome.overrides.set(
    '/packages/optional/catalog.json',
    JSON.stringify(Object.fromEntries(Object.keys(latest).map((name) => [name, catalog[name]])))
  );
}

const items = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .map(({ id, state, version, offered, actions, error }) => ({
        id,
        state,
        version,
        offered,
        actions,
        error,
      }))
  );

const state = (page, id, wanted) =>
  page.within(
    300000,
    ([id, wanted]) =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .some((item) => item.id === id && item.state === wanted && !item.registry),
    [id, wanted]
  );

const act = (page, id, action) =>
  page.evaluate(
    ([id, action]) =>
      document
        .querySelector('slicc-app')
        .model.updates.actPackage(id, action)
        .then(
          () => 'ok',
          (error) => error.message
        ),
    [id, action]
  );

const start = (page, id, action) =>
  page.evaluate(
    ([id, action]) => {
      window.acted = document
        .querySelector('slicc-app')
        .model.updates.actPackage(id, action)
        .then(
          () => 'ok',
          (error) => error.message
        );
    },
    [id, action]
  );

function asked(page) {
  return page.until(() => {
    const dialog = document
      .querySelector('slicc-app')
      ?.shadowRoot?.querySelector('slicc-confirm')
      ?.renderRoot?.querySelector('dialog[open]');
    if (!dialog) return null;
    return {
      title: dialog.querySelector('#title').textContent,
      body: dialog.querySelector('#body').textContent,
      action: dialog.querySelector('[data-action]').textContent.trim(),
    };
  });
}

const answer = (page, button) =>
  page.evaluate((button) => {
    document
      .querySelector('slicc-app')
      .shadowRoot.querySelector('slicc-confirm')
      .renderRoot.querySelector(`[data-${button}]`)
      .click();
  }, button);

async function settled(page, path, done) {
  const end = Date.now() + 60000;
  for (;;) {
    const found = await read(page, path)
      .then(JSON.parse)
      .catch(() => null);
    if ((found && done(found)) || Date.now() > end) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

const LATEST = { [XXD]: '9.2.1172-1', [RSYNC]: '3.5.1-4' };

const packageItems = (page) =>
  page.evaluate(() => document.querySelector('slicc-app').model.updates.packages());

test('the optional packages take npm’s latest, install, update and remove with pnpm add -g, and a hand install shows', async (t) => {
  const page = await chrome.page(t);
  offer(LATEST);
  const [xxd, rsync] = await Promise.all([doc(XXD, LATEST[XXD]), doc(RSYNC, LATEST[RSYNC])]);
  await boot(page);
  await state(page, 'rsync', 'available');
  assert.deepEqual(await items(page), [
    {
      id: 'xxd',
      state: 'available',
      version: null,
      offered: '9.2.1172-1',
      actions: ['install'],
      error: null,
    },
    {
      id: 'rsync',
      state: 'available',
      version: null,
      offered: '3.5.1-4',
      actions: ['install'],
      error: null,
    },
  ]);
  const [row] = await packageItems(page);
  assert.deepEqual(
    [row.description, row.commands, row.size, row.unpacked, row.notes, row.registry],
    [xxd.description, ['xxd'], xxd.dist.unpackedSize, true, ['Hex dumps of any file.'], undefined]
  );
  const listing = await settled(page, 'etc/slicc/optional.json', ([one]) => one.version);
  assert.deepEqual(listing, [
    {
      id: 'xxd',
      package: XXD,
      version: '9.2.1172-1',
      label: 'xxd',
      description: xxd.description,
      commands: ['xxd'],
      requires: [],
    },
    {
      id: 'rsync',
      package: RSYNC,
      version: '3.5.1-4',
      label: 'rsync',
      description: rsync.description,
      commands: ['rsync'],
      requires: ['xxd'],
    },
  ]);

  await run(page, `pnpm add -g ${XXD}@9.2.1167-1 >/dev/null 2>&1; echo "by hand $((40+$?))"`);
  await shows(page, 'by hand 40', 300000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await state(page, 'xxd', 'outdated');
  assert.deepEqual((await items(page))[0], {
    id: 'xxd',
    state: 'outdated',
    version: '9.2.1167-1',
    offered: '9.2.1172-1',
    actions: ['update', 'remove'],
    error: null,
  });

  assert.equal(await act(page, 'rsync', 'install'), 'ok');
  assert.deepEqual(
    (await items(page)).map(({ id, state, version }) => [id, state, version]),
    [
      ['xxd', 'outdated', '9.2.1167-1'],
      ['rsync', 'installed', '3.5.1-4'],
    ]
  );
  await run(page, 'rsync --version | head -1 | grep -c "version 3.5.1" | sed "s/^/rsync ran /"');
  await shows(page, 'rsync ran 1');

  assert.equal(await act(page, 'xxd', 'update'), 'ok');
  assert.deepEqual((await items(page))[0].version, '9.2.1172-1');
  assert.equal((await items(page))[0].state, 'installed');
  await run(page, 'echo hi | xxd');
  await shows(page, '00000000: 6869 0a');

  await start(page, 'xxd', 'remove');
  assert.deepEqual(await asked(page), {
    title: 'Remove xxd?',
    body: 'rsync needs it and stops working until xxd is back.',
    action: 'Remove',
  });
  await answer(page, 'cancel');
  assert.equal(await page.evaluate(() => window.acted), 'ok');
  assert.equal((await items(page))[0].state, 'installed');

  await start(page, 'xxd', 'remove');
  await asked(page);
  await answer(page, 'action');
  assert.equal(await page.evaluate(() => window.acted), 'ok');
  assert.equal((await items(page))[0].state, 'available');
  await run(page, 'xxd -v >/dev/null 2>&1; echo "xxd gone $((1000+$?))"');
  await shows(page, 'xxd gone 1127');

  assert.equal(await act(page, 'rsync', 'remove'), 'ok');
  assert.equal((await items(page))[1].state, 'available');
  assert.deepEqual(page.errors, []);
});

const unreachable = (page) =>
  page.within(120000, () => {
    const rows = document.querySelector('slicc-app').model.updates.packages();
    return rows.length === 2 && rows.every((item) => item.registry === 'unreachable');
  });

test('npm’s data is cached in OPFS, so offline the rows still offer it after a reload', async (t) => {
  const page = await chrome.page(t);
  offer(LATEST);
  await boot(page);
  await state(page, 'rsync', 'available');
  const cache = await settled(
    page,
    'var/lib/slicc/optional/npm.json',
    (found) => found.entries[XXD]
  );
  assert.equal(cache.entries[XXD].version, '9.2.1172-1');

  registry.down = true;
  await boot(page);
  await state(page, 'rsync', 'available');
  assert.deepEqual(
    (await items(page)).map(({ id, offered, actions }) => [id, offered, actions]),
    [
      ['xxd', '9.2.1172-1', ['install']],
      ['rsync', '3.5.1-4', ['install']],
    ]
  );
  assert.ok(
    registry.asked.some((url) => url.endsWith(`${XXD}/latest`)),
    'it still asked npm'
  );
  assert.deepEqual(page.errors, []);
});

test('offline with no cache, the rows never block boot: unreachable with no Install, no version or description for the agent, and the panel’s refresh fetches again', async (t) => {
  const page = await chrome.page(t);
  offer(LATEST);
  registry.down = true;
  await boot(page);
  await unreachable(page);
  const offline = await packageItems(page);
  assert.deepEqual(
    offline.map(({ id, state, offered, description, actions, error, registry: why }) => [
      id,
      state,
      offered,
      description,
      actions,
      error,
      why,
    ]),
    [
      ['xxd', 'available', null, '', ['retry'], null, 'unreachable'],
      ['rsync', 'available', null, '', ['retry'], null, 'unreachable'],
    ]
  );
  const listing = await settled(page, 'etc/slicc/optional.json', () => true);
  assert.deepEqual(listing, [
    { id: 'xxd', package: XXD, label: 'xxd', commands: [], requires: [] },
    { id: 'rsync', package: RSYNC, label: 'rsync', commands: [], requires: ['xxd'] },
  ]);
  registry.down = false;
  await page.evaluate(() => document.querySelector('slicc-app').model.updates.refreshPackages());
  assert.deepEqual(
    (await items(page)).map(({ id, offered, actions }) => [id, offered, actions]),
    [
      ['xxd', '9.2.1172-1', ['install']],
      ['rsync', '3.5.1-4', ['install']],
    ]
  );
  assert.deepEqual(page.errors, []);
});

test('offline with no cache, a row’s Retry (as today’s spectrum sends it) fetches npm again', async (t) => {
  const page = await chrome.page(t);
  offer(LATEST);
  registry.down = true;
  await boot(page);
  await unreachable(page);
  registry.down = false;
  assert.equal(await act(page, 'xxd', 'retry'), 'ok');
  assert.equal((await items(page))[0].offered, '9.2.1172-1');
  assert.equal(await act(page, 'xxd', 'install'), 'ok');
  assert.equal((await items(page))[0].state, 'installed');
  assert.deepEqual(page.errors, []);
});

test('a tarball whose integrity isn’t what npm serves for that version is removed again', async (t) => {
  const page = await chrome.page(t);
  offer(LATEST);
  const packument = JSON.parse(await download(`${REGISTRY}${XXD}`));
  packument.versions[LATEST[XXD]].dist = packument.versions['9.2.1167-1'].dist;
  for (const path of [XXD, XXD.replace('/', '%2f'), XXD.replace('/', '%2F')])
    registry.docs.set(`${REGISTRY}${path}`, JSON.stringify(packument));
  await boot(page);
  await state(page, 'xxd', 'available');

  assert.equal(
    await act(page, 'xxd', 'install'),
    "This version doesn't match the tested build, so it was removed again. Retry later."
  );
  const [xxd] = await items(page);
  assert.equal(xxd.state, 'failed');
  assert.equal(xxd.version, null);
  assert.deepEqual(xxd.actions, ['retry']);
  await run(page, 'xxd -v >/dev/null 2>&1; echo "never kept $((1000+$?))"');
  await shows(page, 'never kept 1127');

  assert.equal(
    await act(page, 'rsync', 'install'),
    "Couldn't install xxd, which rsync needs. Retry."
  );
  assert.equal((await items(page))[1].state, 'failed');
  assert.deepEqual(page.errors, []);
});

test('when npm’s latest fails the gate, the newest older version that passes is offered, and the row names latest’s blocker', async (t) => {
  const page = await chrome.page(t);
  offer({ [XXD]: '9.2.1186-1' });
  await boot(page);
  await run(page, `pnpm add -g ${XXD}@9.2.1172-1 >/dev/null 2>&1; echo "by hand $((40+$?))"`);
  await shows(page, 'by hand 40', 300000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.within(120000, () => {
    const [xxd] = document.querySelector('slicc-app').model.updates.packages();
    return xxd?.version === '9.2.1172-1';
  });
  const [row] = await packageItems(page);
  assert.equal(row.state, 'installed', 'its latest has no provenance, so 9.2.1172-1 is the offer');
  assert.equal(row.offered, '9.2.1172-1');
  assert.deepEqual(row.newer, {
    version: '9.2.1186-1',
    reason: 'wasm-xxd 9.2.1186-1 has no build provenance',
  });
  assert.deepEqual(page.errors, []);
});

test('a failed download shows Retry, and Retry installs it', async (t) => {
  const page = await chrome.page(t);
  offer({ [XXD]: LATEST[XXD] });
  await boot(page);
  await state(page, 'xxd', 'available');

  registry.tarballs = 404;
  const failed = await act(page, 'xxd', 'install');
  registry.tarballs = 0;
  assert.equal(
    failed,
    "Couldn't install xxd: pnpm stopped with an error, shown in the install log. Retry."
  );
  const [xxd] = await items(page);
  assert.equal(xxd.state, 'failed');
  assert.deepEqual(xxd.actions, ['retry']);
  assert.match(
    await page.evaluate(() => document.querySelector('slicc-app').model.updates.packages()[0].log),
    /^@ai-ecoverse\/wasm-xxd@9\.2\.1172-1\n/
  );

  assert.equal(await act(page, 'xxd', 'retry'), 'ok');
  assert.equal((await items(page))[0].state, 'installed');
  assert.deepEqual(page.errors, []);
});

test('the Install / Update panel offers the catalog, in every state', async (t) => {
  const page = await chrome.page(t);
  registry.reset();
  chrome.overrides.delete('/packages/optional/catalog.json');
  await boot(page);
  await state(page, 'git', 'available');
  const color = (value) =>
    page.evaluate((value) => {
      const app = document.querySelector('slicc-app');
      if (app.color !== value) app.toggleColor();
    }, value);
  const show = async () => {
    await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
    await page.until(
      () =>
        !!document
          .querySelector('slicc-app')
          .dock.content('updates')
          ?.shadowRoot?.querySelector('section[data-section="packages"] li')
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
  const shots = async (name) => {
    await color('light');
    await show();
    await page.screenshot(new URL(`${name}-light.png`, page.dir));
    await color('dark');
    await page.screenshot(new URL(`${name}-dark.png`, page.dir));
    await color('light');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.until(() => document.querySelector('slicc-app').screen === 'phone');
    await show();
    await page.screenshot(new URL(`${name}-420.png`, page.dir));
    await page.send('Emulation.clearDeviceMetricsOverride');
    await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  };

  await run(
    page,
    'pnpm add -g @ai-ecoverse/wasm-poppler@26.10.0-1 >/dev/null 2>&1; echo "by hand $((40+$?))"'
  );
  await shows(page, 'by hand 40', 300000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await state(page, 'pdf', 'outdated');
  assert.equal(await act(page, 'rsync', 'install'), 'ok');
  registry.tarballs = 404;
  assert.match(await act(page, 'dig', 'install'), /^Couldn't install dig/);
  registry.tarballs = 0;

  await start(page, 'jsh-browser', 'install');
  await state(page, 'node', 'installing');
  assert.equal(
    await page.evaluate(
      () =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .find((item) => item.id === 'jsh-browser').state
    ),
    'queued'
  );
  await shots('packages');
  assert.equal(await page.within(600000, () => window.acted), 'ok');
  const owners = new Map();
  for (const { id, commands } of await packageItems(page))
    for (const command of commands) {
      assert.equal(owners.get(command), undefined, `${command}: ${owners.get(command)} and ${id}`);
      owners.set(command, id);
    }
  assert.equal(owners.get('magick'), 'imagemagick');
  assert.equal(owners.get('git-upload-pack'), undefined, 'a helper isn’t listed');
  assert.deepEqual(
    (await items(page)).map(({ id, state }) => `${id} ${state}`),
    [
      'git available',
      'gh available',
      'ssh available',
      'slicc available',
      'python available',
      'pydata available',
      'node installed',
      'jsh-browser installed',
      'ruby available',
      'perl available',
      'biome available',
      'pdf outdated',
      'qpdf available',
      'heif available',
      'rsync installed',
      'sqlite3 available',
      'screen available',
      'dig failed',
      'websocat available',
      'ntfy available',
      'gpg available',
      'mcpcat available',
      'imagemagick available',
      'zip available',
      'xxd available',
    ]
  );

  await color('light');
  await show();
  await page.screenshot(new URL('packages-installed-light.png', page.dir));
  await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      .shadowRoot.querySelector('li[data-id="dig"]')
      .scrollIntoView({ block: 'start' })
  );
  await page.screenshot(new URL('packages-failed-outdated-light.png', page.dir));
  await color('dark');
  await page.screenshot(new URL('packages-failed-outdated-dark.png', page.dir));
  await color('light');

  await start(page, 'node', 'remove');
  assert.deepEqual(await asked(page), {
    title: 'Remove Node.js (jsh)?',
    body: 'Browser for jsh scripts needs it and stops working until Node.js (jsh) is back.',
    action: 'Remove',
  });
  await shots('requires-confirm');
  await answer(page, 'cancel');
  assert.equal(await page.evaluate(() => window.acted), 'ok');
  assert.deepEqual(page.errors, []);
});
