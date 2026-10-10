import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const XXD = '@ai-ecoverse/wasm-xxd';
const RSYNC = '@ai-ecoverse/wasm-rsync';
const integrity = {
  [`${XXD}@9.2.1172-1`]:
    'sha512-8FuxzvfiBOHmQDya1crvnSRav6zG2hA4lo+bX2/LJT17YYT0yNZ445t7p5PhlsUFUy9ZiBEVFRV7nl0C2BANow==',
  [`${XXD}@9.2.1167-1`]:
    'sha512-jW15CFJsttJMquG2v61IUHrdBUmivOLgqwX9s7e6ex3sI3Sh8/Kn8we8VJweAVF49HgSsjamDGRnUTGrXnZd0Q==',
  [`${RSYNC}@3.4.4-1`]:
    'sha512-SBtC+qgNGGWMoZ1kCO8jbwgLcg4/douU/xLOuxKbOJTwl5hGQ0SOWTBXkZrO4Fp9jPDnXEkkX+KkfLdslI6nGw==',
};

function offer(pins, locks = integrity) {
  const catalog = {
    [XXD]: {
      id: 'xxd',
      label: 'xxd',
      description: 'Hex dumps of any file.',
      commands: ['xxd'],
      size: 30000,
    },
    [RSYNC]: {
      id: 'rsync',
      label: 'rsync',
      description: 'Copies and syncs folders.',
      commands: ['rsync'],
      requires: ['xxd'],
      size: 921609,
    },
  };
  const packages = Object.fromEntries(
    Object.entries(pins).map(([name, version]) => [
      `node_modules/${name}`,
      { version, integrity: locks[`${name}@${version}`] },
    ])
  );
  chrome.overrides.set(
    '/packages/optional/catalog.json',
    JSON.stringify(Object.fromEntries(Object.keys(pins).map((name) => [name, catalog[name]])))
  );
  chrome.overrides.set(
    '/packages/optional/package.json',
    JSON.stringify({ name: 'slicc-bios-optional', private: true, dependencies: pins })
  );
  chrome.overrides.set(
    '/packages/optional/package-lock.json',
    JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: pins }, ...packages } })
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
        .find((item) => item.id === id)?.state === wanted,
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

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test('the optional packages install, update and remove with pnpm add -g, and a hand install shows', async (t) => {
  const page = await chrome.page(t);
  offer({ [XXD]: '9.2.1172-1', [RSYNC]: '3.4.4-1' });
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
      offered: '3.4.4-1',
      actions: ['install'],
      error: null,
    },
  ]);
  assert.deepEqual(JSON.parse(await read(page, 'etc/slicc/optional.json')), [
    {
      id: 'xxd',
      package: XXD,
      version: '9.2.1172-1',
      label: 'xxd',
      description: 'Hex dumps of any file.',
      commands: ['xxd'],
      requires: [],
    },
    {
      id: 'rsync',
      package: RSYNC,
      version: '3.4.4-1',
      label: 'rsync',
      description: 'Copies and syncs folders.',
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
      ['rsync', 'installed', '3.4.4-1'],
    ]
  );
  await run(page, 'rsync --version | head -1 | grep -c "version 3.4.4" | sed "s/^/rsync ran /"');
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

test('a build that does not match the catalog is removed again', async (t) => {
  const page = await chrome.page(t);
  offer(
    { [XXD]: '9.2.1172-1', [RSYNC]: '3.4.4-1' },
    { ...integrity, [`${XXD}@9.2.1172-1`]: integrity[`${XXD}@9.2.1167-1`] }
  );
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

test('a failed download shows Retry, and Retry installs it', async (t) => {
  const page = await chrome.page(t);
  offer({ [XXD]: '9.2.1172-1' });
  await boot(page);
  await state(page, 'xxd', 'available');

  chrome.cdn.status = 404;
  const failed = await act(page, 'xxd', 'install');
  chrome.cdn.status = 0;
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
  chrome.cdn.status = 404;
  assert.match(await act(page, 'esbuild', 'install'), /^Couldn't install esbuild/);
  chrome.cdn.status = 0;

  await start(page, 'uv', 'install');
  await state(page, 'python', 'installing');
  assert.equal(
    await page.evaluate(
      () =>
        document
          .querySelector('slicc-app')
          .model.updates.packages()
          .find((item) => item.id === 'uv').state
    ),
    'queued'
  );
  await shots('packages');
  assert.equal(await page.within(600000, () => window.acted), 'ok');
  assert.deepEqual(
    (await items(page)).map(({ id, state }) => `${id} ${state}`),
    [
      'git available',
      'python installed',
      'uv installed',
      'esbuild failed',
      'tsc available',
      'biome available',
      'pdf outdated',
      'qpdf available',
      'rsync installed',
      'buf available',
      'tar available',
      'screen available',
      'hf available',
      'dig available',
    ]
  );

  await color('light');
  await show();
  await page.screenshot(new URL('packages-installed-light.png', page.dir));
  await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      .shadowRoot.querySelector('li[data-id="esbuild"]')
      .scrollIntoView({ block: 'start' })
  );
  await page.screenshot(new URL('packages-failed-outdated-light.png', page.dir));
  await color('dark');
  await page.screenshot(new URL('packages-failed-outdated-dark.png', page.dir));
  await color('light');

  await start(page, 'python', 'remove');
  assert.deepEqual(await asked(page), {
    title: 'Remove Python?',
    body: 'uv needs it and stops working until Python is back.',
    action: 'Remove',
  });
  await shots('requires-confirm');
  await answer(page, 'cancel');
  assert.equal(await page.evaluate(() => window.acted), 'ok');
  assert.deepEqual(page.errors, []);
});
