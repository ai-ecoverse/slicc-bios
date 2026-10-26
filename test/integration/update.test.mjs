import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { loadCatalog } from '../../src/seed/packages.js';
import { OWNER, REGISTRY } from '../../src/seed/releases.js';
import {
  boot,
  booted,
  eventually,
  installable,
  opfs,
  prompt,
  ready,
  run,
  screen,
  shows,
  watch,
} from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const bash = 'node_modules/@ai-ecoverse/wasm-bash';
const locked = JSON.parse(
  await readFile(new URL('../../src/packages/package-lock.json', import.meta.url), 'utf8')
).packages[bash];
const SHIPPED = locked.version;
const shipped = locked.integrity;
const older =
  'sha512-pusddMmR2Y7k1fSDtF8vCNzPcpe4LCPEvwPhsxhnx9V7NmMcdudBvPE1nKLzetnqNQtXLjVaMNvKPxzrLO9KGw==';
const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml'];

async function downgrade() {
  for (const file of files) {
    const text = await readFile(new URL(`../../src/packages/${file}`, import.meta.url), 'utf8');
    const pinned = text.replaceAll(SHIPPED, '5.3.0-13').replaceAll(shipped, older);
    chrome.overrides.set(`/packages/${file}`, pinned);
  }
}

function deploy() {
  for (const file of files) chrome.overrides.delete(`/packages/${file}`);
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

async function version(page) {
  return JSON.parse(await read(page, `${bash}/package.json`)).version;
}

async function row(page, id) {
  return page.evaluate(
    (id) =>
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === id),
    id
  );
}

async function updated(page) {
  deploy();
  chrome.cdn.requests.length = 0;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.until(() =>
    /ready|failed/.test(
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'bios').state
    )
  );
  const bios = await row(page, 'bios');
  assert.equal(bios.state, 'ready', bios.error);
}

const OLDER = ['slicc:/home# ', 'slicc:/home$ '];

async function bootOlder(page) {
  await downgrade();
  await boot(page, OLDER);
  assert.equal(await version(page), '5.3.0-13');
  assert.equal((await row(page, 'bios')).state, 'current');
}

test('pins the same packages in the bootstrap and the pnpm lockfile', async () => {
  const source = (file) => readFile(new URL(`../../src/packages/${file}`, import.meta.url), 'utf8');
  const npm = Object.entries(JSON.parse(await source('package-lock.json')).packages)
    .filter(([path]) => path)
    .map(
      ([path, { version, integrity }]) =>
        `${path.split('node_modules/').at(-1)}@${version} ${integrity}`
    );
  const pnpm = [
    ...(await source('pnpm-lock.yaml')).matchAll(
      /^ {2}'?(\S+?)'?:\n {4}resolution: \{integrity: (\S+)\}/gm
    ),
  ].map(([, id, integrity]) => `${id} ${integrity}`);
  assert.ok(npm.length >= 7, `${npm.length} packages`);
  assert.deepEqual(npm.sort(), pnpm.sort());
});

async function reload(page) {
  await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
  await page.until(
    () =>
      !!document
        .querySelector('slicc-app')
        .dock.content('updates')
        ?.shadowRoot?.querySelector('article[data-id="bios"] swc-button[data-action="reload"]')
  );
  await page.screenshot(new URL('updates-panel.png', page.dir));
  await page.evaluate(() => {
    window.stale = true;
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      .shadowRoot.querySelector('article[data-id="bios"] swc-button[data-action="reload"]')
      .click();
  });
  await page.until(() => !window.stale && location.pathname === '/os/');
  await ready(page);
}

test('updates a running install from a bumped lockfile', async (t) => {
  const page = await chrome.page(t);
  await bootOlder(page);
  await run(page, 'session=kept; mkdir work; echo draft > work/notes.txt; echo ok"k"');
  await shows(page, 'okk');

  await t.test('installs the new version in place while the shell keeps running', async () => {
    await updated(page);
    const bios = await row(page, 'bios');
    assert.deepEqual(
      [bios.log, bios.actions, bios.from],
      [`@ai-ecoverse/wasm-bash 5.3.0-13 → ${SHIPPED}`, ['reload'], bios.to]
    );
    await page.until(
      () =>
        document.querySelector('slicc-app').model.updates.ready() &&
        !document.querySelector('slicc-app').dock.api.getPanel('updates')
    );
    assert.match(
      await page.evaluate(
        () => document.querySelector('slicc-app').shadowRoot.querySelector('#updates')?.textContent
      ),
      /Update ready|Updating \d/
    );
    assert.equal(await version(page), SHIPPED);
    assert.equal(
      await read(page, 'var/lib/slicc/pnpm-lock.yaml'),
      await readFile(new URL('../../src/packages/pnpm-lock.yaml', import.meta.url), 'utf8')
    );
    assert.deepEqual(
      [
        ...new Set(
          chrome.cdn.requests.filter((url) => url.includes('/wasm-bash/') && url.endsWith('.tgz'))
        ),
      ],
      [`https://registry.npmjs.org/@ai-ecoverse/wasm-bash/-/wasm-bash-${SHIPPED}.tgz`]
    );
    assert.deepEqual(
      (await opfs(page)).filter(
        (path) => path.includes('slicc-ortllama') || path.includes('onnxruntime-web')
      ),
      []
    );
    assert.deepEqual(
      chrome.cdn.requests.filter((url) => /slicc-ortllama|onnxruntime-web/.test(url)),
      []
    );
    await page.screenshot(new URL('updated.png', page.dir));

    await run(
      page,
      `echo "$session $(bash -c 'head -3 /${bash}/package.json' | tail -1 | tr -d ' ')"`
    );
    await shows(page, `kept "version":"${SHIPPED}",`);
  });

  await t.test('keeps what the shell wrote across the update', async () => {
    assert.equal(await read(page, 'home/work/notes.txt'), 'draft\n');
  });

  await t.test(
    'reloads onto the new version through the BIOS without downloading it again',
    async () => {
      chrome.cdn.requests.length = 0;
      const bios = await watch(page);
      await reload(page);
      await eventually(() => assert.deepEqual(bios.states(), booted));
      assert.equal(bios.texts('packages').at(-1), `0/${installable} downloaded from npm, 0B`);
      assert.deepEqual(
        chrome.cdn.requests.filter((url) => url.endsWith('.tgz')),
        []
      );
      assert.equal(await version(page), SHIPPED);
      assert.equal((await row(page, 'bios')).state, 'current');
      await run(page, 'cat work/notes.txt');
      await shows(page, 'draft');
      assert.deepEqual(page.errors, []);
    }
  );
});

async function notesBurst() {
  const { entries, retired } = await loadCatalog(new URL('packages/optional/', chrome.url));
  const noted = new Set([...entries, ...retired].map((entry) => entry.package.replace('/', '%2F')));
  const doc = ({ origin, pathname }) => {
    const [, name, version, ...rest] = pathname.split('/');
    return origin === REGISTRY && noted.has(name) && /^\d/.test(version ?? '') && !rest.length;
  };
  const releases = ({ origin, pathname }) => {
    const [, repos, owner, repo, list, ...rest] = pathname.split('/');
    return (
      origin === chrome.github.origin &&
      repos === 'repos' &&
      owner === OWNER &&
      Boolean(repo) &&
      list === 'releases' &&
      !rest.length
    );
  };
  return (url) => doc(new URL(url)) || releases(new URL(url));
}

test('code is highlighted offline by spectrum’s own highlighter, and a profile’s old /opt/grammars goes', async (t) => {
  const page = await chrome.page(t);
  const burst = await notesBurst();
  await boot(page);
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
    await put('opt/grammars/node_modules/@shikijs/langs/package.json', '{"version":"4.5.0"}');
    await put('var/lib/slicc/grammars/pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  });
  await page.reload();
  await ready(page);
  const exists = (path) =>
    page.evaluate(async (path) => {
      let dir = await navigator.storage.getDirectory();
      try {
        for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part);
        return true;
      } catch {
        return false;
      }
    }, path);
  await page.within(5 * 60 * 1000, async () => {
    const gone = async (path) => {
      let dir = await navigator.storage.getDirectory();
      try {
        for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part);
        return false;
      } catch {
        return true;
      }
    };
    return (await gone('opt/grammars')) && (await gone('var/lib/slicc/grammars'));
  });
  assert.deepEqual(
    [await exists('opt/grammars'), await exists('var/lib/slicc/grammars')],
    [false, false]
  );
  assert.equal(await row(page, 'grammars'), undefined);
  assert.equal(
    await page.evaluate(() => document.querySelector('slicc-app').grammarBase),
    undefined
  );

  await run(
    page,
    `clear; mkdir -p /home/hl && printf 'fn main() {\\n    let answer: u32 = 42;\\n    println!("{}", answer);\\n}\\n' > /home/hl/main.rs && echo written-$((40 + 2))`
  );
  await shows(page, 'written-42');
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  t.after(() =>
    page
      .send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
      .catch(() => {})
  );
  chrome.cdn.requests.length = 0;
  const before = await page.evaluate(() => performance.getEntriesByType('resource').length);
  await page.evaluate(() => document.querySelector('slicc-app').open('file', '/home/hl/main.rs'));
  const colours = await page.within(60000, () => {
    const view = document.querySelector('slicc-app').dock.content('file:/home/hl/main.rs');
    const code = view?.shadowRoot
      ?.querySelector('slicc-code-view')
      ?.shadowRoot?.querySelector('diffs-container')?.shadowRoot;
    const tokens = [...(code?.querySelectorAll('[data-line] span') ?? [])].filter((span) =>
      span.textContent.trim()
    );
    const text = tokens.map((span) => span.textContent).join('');
    if (!text.includes('answer')) return false;
    const seen = new Set(tokens.map((span) => getComputedStyle(span).color));
    return seen.size >= 3 && [...seen];
  });
  assert.ok(colours.length >= 3, JSON.stringify(colours));
  const fetched = await page.evaluate(
    (before) =>
      performance
        .getEntriesByType('resource')
        .slice(before)
        .map((entry) => entry.name)
        .filter((name) => new URL(name).origin !== location.origin),
    before
  );
  assert.deepEqual(
    fetched.filter((url) => !burst(url)),
    []
  );
  assert.deepEqual(
    chrome.cdn.requests.filter((url) => !burst(url)),
    []
  );
  assert.equal((await opfs(page)).filter((path) => path.includes('@shikijs')).length, 0);
  assert.deepEqual(page.errors, []);
});

test('a profile without the old grammars receipt keeps its own /opt/grammars through an update check', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['opt', 'grammars'])
      dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle('keep', { create: true })).createWritable();
    await writable.write('mine\n');
    await writable.close();
  });
  await page.reload();
  chrome.cdn.requests.length = 0;
  await ready(page);
  const notes = (url) =>
    /^https:\/\/registry\.npmjs\.org\/@ai-ecoverse%2Fwas(m|i|ix)-[^/]+\/\d/.test(url);
  const end = Date.now() + 5 * 60 * 1000;
  while (!chrome.cdn.requests.some(notes)) {
    assert.ok(
      Date.now() < end,
      `no release-notes fetch after the update check in 5 min, last requests: ${chrome.cdn.requests.slice(-5).join(', ')}`
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(
    await page.evaluate(async () => {
      try {
        const opt = await (await navigator.storage.getDirectory()).getDirectoryHandle('opt');
        const grammars = await opt.getDirectoryHandle('grammars');
        return await (await (await grammars.getFileHandle('keep')).getFile()).text();
      } catch (error) {
        return error.name;
      }
    }),
    'mine\n'
  );
  assert.deepEqual(page.errors, []);
});

test('an /opt/agent installed without a workspace file updates to a pruned one', async (t) => {
  const page = await chrome.page(t);
  const manifest = '{"name":"slicc-bios-agent","private":true,"dependencies":{"is-odd":"3.0.1"}}';
  const deploy = (lock, workspace) => {
    chrome.overrides.set('/packages/agent/package.json', manifest);
    chrome.overrides.set('/packages/agent/pnpm-lock.yaml', lock);
    chrome.overrides.set('/packages/agent/pnpm-workspace.yaml', workspace);
  };
  const plain = "minimumReleaseAgeExclude:\n  - '@ai-ecoverse/*'\n";
  const agentRow = () =>
    page.evaluate(() =>
      document
        .querySelector('slicc-app')
        .model.updates.list()
        .find((item) => item.id === 'agent')
    );
  deploy(
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      is-odd:\n        specifier: 3.0.1\n        version: 3.0.1\n\npackages:\n\n  is-number@6.0.0:\n    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}\n    engines: {node: '>=0.10.0'}\n\n  is-odd@3.0.1:\n    resolution: {integrity: sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==}\n    engines: {node: '>=4'}\n\nsnapshots:\n\n  is-number@6.0.0: {}\n\n  is-odd@3.0.1:\n    dependencies:\n      is-number: 6.0.0\n",
    plain
  );
  await boot(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .some((item) => item.id === 'agent' && item.state === 'installed')
  );
  const installed = (await opfs(page)).filter((path) => path.startsWith('opt/agent/'));
  assert.ok(installed.some((path) => path.includes('/is-number/package.json')));
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const opt = await (await root.getDirectoryHandle('opt')).getDirectoryHandle('agent');
    await opt.removeEntry('pnpm-workspace.yaml');
  });

  deploy(
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\noverrides:\n  is-number: '-'\n\nimporters:\n\n  .:\n    dependencies:\n      is-odd:\n        specifier: 3.0.1\n        version: 3.0.1\n\npackages:\n\n  is-odd@3.0.1:\n    resolution: {integrity: sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==}\n    engines: {node: '>=4'}\n\nsnapshots:\n\n  is-odd@3.0.1: {}\n",
    `${plain}overrides:\n  is-number: '-'\n`
  );
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.within(5 * 60 * 1000, async () => {
    const root = await navigator.storage.getDirectory();
    try {
      const lib = await (
        await (
          await (await root.getDirectoryHandle('var')).getDirectoryHandle('lib')
        ).getDirectoryHandle('slicc')
      ).getDirectoryHandle('agent');
      return (await (await (await lib.getFileHandle('pnpm-lock.yaml')).getFile()).text()).includes(
        'overrides:'
      );
    } catch {
      return false;
    }
  });
  const row = await agentRow();
  assert.notEqual(row.state, 'failed', row.error);
  assert.match(await read(page, 'opt/agent/pnpm-workspace.yaml'), /is-number: '-'/);
  const pruned = (await opfs(page)).filter((path) => path.startsWith('opt/agent/'));
  assert.ok(pruned.some((path) => path.includes('/is-odd/package.json')));
  assert.ok(!pruned.some((path) => path.includes('/is-number/package.json')), pruned.join('\n'));
  assert.deepEqual(page.errors, []);
});

const MS =
  'sha512-GsCCIZDE/p3i96vtEqx+7dBUGXrc7zeSK3wwPHIaRThS+9OhWIXRqzs4d6k1SVU8g91DrNRWxWUGhp5KXQb2VA==';
const ESTREE =
  'sha512-dWHzHa2WqEXI/O1E9OjrocMTKJl2mSrEolh1Iomrv6U+JuNwaHXsXx9bLu5gG7BUWFIN0skIQJQ/L1rIex4X6w==';
const PREFIX =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n";
const BASE_LOCK = `${PREFIX}      '@types/ms':\n        specifier: 2.1.0\n        version: 2.1.0\n\npackages:\n\n  '@types/ms@2.1.0':\n    resolution: {integrity: ${MS}}\n\nsnapshots:\n\n  '@types/ms@2.1.0': {}\n`;
const NEWER_LOCK = `${PREFIX}      '@types/estree':\n        specifier: 1.0.8\n        version: 1.0.8\n      '@types/ms':\n        specifier: 2.1.0\n        version: 2.1.0\n\npackages:\n\n  '@types/estree@1.0.8':\n    resolution: {integrity: ${ESTREE}}\n\n  '@types/ms@2.1.0':\n    resolution: {integrity: ${MS}}\n\nsnapshots:\n\n  '@types/estree@1.0.8': {}\n\n  '@types/ms@2.1.0': {}\n`;
const AGENT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

function deployAgent(dependencies, lock) {
  const manifest = JSON.stringify({ name: 'slicc-bios-agent', private: true, dependencies });
  chrome.overrides.set('/packages/agent/package.json', manifest);
  chrome.overrides.set('/packages/agent/pnpm-lock.yaml', lock);
  chrome.overrides.set(
    '/packages/agent/pnpm-workspace.yaml',
    "minimumReleaseAgeExclude:\n  - '@ai-ecoverse/*'\n"
  );
}

async function installedVersion(page, name) {
  return JSON.parse(await read(page, `opt/agent/node_modules/${name}/package.json`)).version;
}

async function own(page) {
  return page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .filter((item) => item.origin === 'user')
      .map(({ id, state, version, pin, actions, error }) => ({
        id,
        state,
        version,
        pin,
        actions,
        error,
      }))
  );
}

async function settled(page, lock) {
  await page.within(
    5 * 60 * 1000,
    async (lock) => {
      const root = await navigator.storage.getDirectory();
      try {
        let dir = root;
        for (const part of ['var', 'lib', 'slicc', 'agent'])
          dir = await dir.getDirectoryHandle(part);
        const user = JSON.parse(
          await (await (await dir.getFileHandle('user.json')).getFile()).text()
        );
        const recorded = await (await (await dir.getFileHandle('pnpm-lock.yaml')).getFile()).text();
        return recorded === lock && !user.pending;
      } catch {
        return false;
      }
    },
    lock
  );
}

async function yours(page) {
  await page.evaluate(() => {
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    focused?.blur();
    document
      .querySelector('slicc-app')
      .dock.content('updates')
      .shadowRoot.querySelector('section[data-section="user-packages"]')
      .scrollIntoView({ block: 'start' });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function checkNow(page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test("the user's pnpm add in /opt/agent moves to /opt/user, and a pnpm upgrade there survives seven's updates", async (t) => {
  t.after(() => {
    for (const file of AGENT_FILES) chrome.overrides.delete(`/packages/agent/${file}`);
  });
  const page = await chrome.page(t);
  deployAgent({ '@types/ms': '2.1.0' }, BASE_LOCK);
  await page.goto('/#users=off');
  await ready(page);
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.list()
      .some((item) => item.id === 'agent' && item.state === 'installed')
  );
  await run(
    page,
    'cd /opt/agent; pnpm add @types/semver@7.7.1 @types/ms@0.7.34; echo added-$((40+2))-$?'
  );
  await shows(page, 'added-42-', 5 * 60 * 1000);
  assert.match(await screen(page), /added-42-0/, await screen(page));
  await checkNow(page);
  await page.until(
    () =>
      document
        .querySelector('slicc-app')
        .model.updates.packages()
        .filter((item) => item.origin === 'user').length === 2
  );
  assert.deepEqual(await own(page), [
    {
      id: 'user:agent:@types/ms',
      state: 'installed',
      version: '0.7.34',
      pin: { base: '2.1.0', range: '0.7.34', project: '/opt/agent' },
      actions: ['unpin'],
      error: null,
    },
    {
      id: 'user:agent:@types/semver',
      state: 'installed',
      version: '7.7.1',
      pin: { base: null, range: '7.7.1', project: '/opt/agent' },
      actions: ['remove'],
      error: null,
    },
  ]);

  await t.test(
    'the next check moves the addition to /opt/user, and the agent update keeps the pin',
    async () => {
      deployAgent({ '@types/ms': '2.1.0', '@types/estree': '1.0.8' }, NEWER_LOCK);
      await checkNow(page);
      await settled(page, NEWER_LOCK);
      const agent = await row(page, 'agent');
      assert.notEqual(agent.state, 'failed', agent.error);
      const manifest = JSON.parse(await read(page, 'opt/agent/package.json'));
      assert.deepEqual(manifest.dependencies, {
        '@types/ms': '0.7.34',
        '@types/estree': '1.0.8',
      });
      assert.equal(await installedVersion(page, '@types/estree'), '1.0.8');
      assert.deepEqual(JSON.parse(await read(page, 'var/lib/slicc/agent/user.json')).add, {});
      assert.deepEqual(JSON.parse(await read(page, 'opt/user/package.json')).dependencies, {
        '@types/semver': '7.7.1',
      });
      assert.equal(
        JSON.parse(await read(page, 'opt/user/node_modules/@types/semver/package.json')).version,
        '7.7.1'
      );
      const installed = (await opfs(page)).filter((path) =>
        path.startsWith('opt/agent/node_modules/')
      );
      assert.ok(!installed.some((path) => path.includes('/@types/semver/')), installed.join('\n'));
    }
  );

  await t.test('a user pin survives the update and wins over the base', async () => {
    assert.equal(await installedVersion(page, '@types/ms'), '0.7.34');
    assert.deepEqual(JSON.parse(await read(page, 'var/lib/slicc/agent/user.json')).pin, {
      '@types/ms': { spec: '0.7.34', field: 'dependencies', base: '2.1.0' },
    });
    const rows = await own(page);
    assert.deepEqual(
      rows.map(({ id, version, pin }) => [id, version, pin]),
      [
        [
          'user:agent:@types/ms',
          '0.7.34',
          { base: '2.1.0', range: '0.7.34', project: '/opt/agent' },
        ],
        ['user:user:@types/semver', '7.7.1', { base: null, range: '7.7.1', project: '/opt/user' }],
      ]
    );
    await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
    await page.until(
      () =>
        !!document
          .querySelector('slicc-app')
          .dock.content('updates')
          ?.shadowRoot?.querySelector(
            'section[data-section="user-packages"] li[data-id="user:agent:@types/ms"]'
          )
    );
    const color = (wanted) =>
      page.evaluate((wanted) => {
        const app = document.querySelector('slicc-app');
        if (app.color !== wanted) app.toggleColor();
      }, wanted);
    await color('light');
    await yours(page);
    await page.screenshot(new URL('your-packages-light.png', page.dir));
    await color('dark');
    await yours(page);
    await page.screenshot(new URL('your-packages-dark.png', page.dir));
    await color('light');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.until(() => document.querySelector('slicc-app').screen === 'phone');
    await page.evaluate(() => document.querySelector('slicc-app').show('updates'));
    await page.until(
      () =>
        !!document
          .querySelector('slicc-app')
          .dock.content('updates')
          ?.shadowRoot?.querySelector(
            'section[data-section="user-packages"] li[data-id="user:agent:@types/ms"]'
          )
    );
    await yours(page);
    await page.screenshot(new URL('your-packages-420.png', page.dir));
    await page.send('Emulation.clearDeviceMetricsOverride');
    await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  });

  await t.test(
    'unpin restores the base version, and removing the addition the shipped lockfile',
    async () => {
      await page.evaluate(() =>
        document
          .querySelector('slicc-app')
          .model.updates.actPackage('user:agent:@types/ms', 'unpin')
      );
      await settled(page, NEWER_LOCK);
      assert.equal(await installedVersion(page, '@types/ms'), '2.1.0');
      assert.deepEqual(
        (await own(page)).map(({ id }) => id),
        ['user:user:@types/semver']
      );
      await page.evaluate(() =>
        document
          .querySelector('slicc-app')
          .model.updates.actPackage('user:user:@types/semver', 'remove')
      );
      await page.until(
        () =>
          !document
            .querySelector('slicc-app')
            .model.updates.packages()
            .some((item) => item.origin === 'user')
      );
      assert.deepEqual(
        JSON.parse(await read(page, 'opt/user/package.json')).dependencies ?? {},
        {}
      );
      assert.equal(await read(page, 'opt/agent/pnpm-lock.yaml'), NEWER_LOCK);
      assert.deepEqual(JSON.parse(await read(page, 'opt/agent/package.json')).dependencies, {
        '@types/ms': '2.1.0',
        '@types/estree': '1.0.8',
      });
      const installed = (await opfs(page)).filter((path) =>
        path.startsWith('opt/user/node_modules/')
      );
      assert.ok(!installed.some((path) => path.includes('/@types/semver/')), installed.join('\n'));
      assert.deepEqual(page.errors, []);
    }
  );
});

const EXEC_LOOP = [
  '#!/bin/bash',
  "{ cat /proc/mounts; stat -c 'tmp %d %i' /tmp; } > /root/loop-start.txt 2>&1",
  'n=0; f=0',
  "ok() { bash -c 'echo exec-ok' > /tmp/v 2>&1 && grep -q exec-ok /tmp/v; }",
  'while [ ! -e /tmp/stop ]; do',
  '  ok || { f=$((f+1)); cat /tmp/v >> /tmp/errs; }',
  '  n=$((n+1)); sleep 0.01',
  'done',
  'echo "loop n=$n fail=$f" > /tmp/loop',
].join('\n');

async function lostLoop(page, error, stopped) {
  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const tmp = await root.getDirectoryHandle('tmp');
    const names = [];
    for await (const handle of tmp.values()) names.push(handle.name);
    return { same: await globalThis.tmpAtStart.isSameEntry(tmp), names: names.sort() };
  });
  const kept = (path) => read(page, path).catch(() => `no ${path}`);
  const loopStart = await kept('root/loop-start.txt');
  const loopEnd = `${await kept('root/loop-exit.txt')} ${await kept('root/loop-err.txt')}`;
  await run(
    page,
    `clear; echo "now: $(stat -c 'tmp %d %i' /tmp) $(ls -a /tmp | tr '\\n' ' ')"; sleep 2; echo "later: $(sh -c 'ls -a /tmp' | tr '\\n' ' ')"; echo seen-$((40 + 2))`
  );
  await shows(page, 'seen-42');
  const kernel = (page.console ?? []).filter((line) => line.includes('slicc-kernel:')).slice(0, 10);
  throw new Error(
    [
      `tmp/loop isn't in OPFS (#663): ${error.message.split('\n')[0]}`,
      `the shell after the stop: ${stopped}`,
      `the loop's exit and stderr: ${loopEnd}`,
      `the OPFS /tmp is the one from the loop's start: ${opfs.same}`,
      `OPFS /tmp: ${opfs.names.join(' ')}`,
      `the loop's mounts at its start:\n${loopStart}`,
      `the kernel's view: ${(await screen(page)).replace(/\s+/g, ' ')}`,
      `kernel console: ${kernel.join(' | ') || 'none'}`,
    ].join('\n')
  );
}

test('the BIOS installer replaces a package in place while seven runs: the shell execs it in a loop and a second tab reads its files throughout', async (t) => {
  const page = await chrome.page(t);
  await bootOlder(page);
  chrome.overrides.set('/probe.html', '<!doctype html><title>probe</title>');
  const other = await page.tab();
  await other.goto('/probe.html');
  await other.evaluate((bash) => {
    window.probe = { reads: 0, missing: [] };
    const look = async () => {
      let dir = await navigator.storage.getDirectory();
      for (const part of bash.split('/')) dir = await dir.getDirectoryHandle(part);
      const names = [];
      for await (const handle of dir.values()) names.push(handle.name);
      if (!names.includes('package.json') || names.length < 2) {
        throw new Error(`missing: ${names.join(',')}`);
      }
      await (await dir.getFileHandle('package.json')).getFile();
    };
    window.probe.running = true;
    void (async () => {
      while (window.probe.running) {
        await look().catch((error) => window.probe.missing.push(error.message));
        window.probe.reads += 1;
      }
    })();
  }, bash);
  await page.send('Page.bringToFront');
  await shows(page, prompt);
  const script = Buffer.from(`${EXEC_LOOP}\n`).toString('base64');
  await run(
    page,
    `clear; rm -f /tmp/stop /tmp/loop /tmp/errs; echo ${script} | base64 -d > /usr/local/bin/exec-loop; chmod 755 /usr/local/bin/exec-loop; rm -f /root/loop-exit.txt; (exec-loop > /dev/null 2> /root/loop-err.txt; echo "exit=$?" > /root/loop-exit.txt) & echo looping-$((40 + 2))`
  );
  await shows(page, 'looping-42');
  await page.evaluate(async () => {
    globalThis.tmpAtStart = await (await navigator.storage.getDirectory()).getDirectoryHandle(
      'tmp'
    );
  });
  deploy();
  const result = await other.evaluate(
    () =>
      new Promise((resolve) => {
        const { port } = new SharedWorker('/installer.js', 'slicc-installer');
        port.onmessage = ({ data }) => {
          if ('progress' in data) return;
          resolve(data);
        };
        port.postMessage({
          id: 1,
          op: 'packages',
          args: {
            from: new URL('/packages/package-lock.json', location.href).href,
            base: 'opt/slicc/base',
          },
        });
      })
  );
  assert.ok(result.result?.downloaded >= 1, JSON.stringify(result));
  await run(page, 'clear; touch /tmp/stop; wait; cat /tmp/loop; echo stopped-$((40 + 2))');
  await shows(page, 'stopped-42', 120000);
  const stopped = (await screen(page)).replace(/\s+/g, ' ');
  const counted = (
    await read(page, 'tmp/loop').catch((error) => lostLoop(page, error, stopped))
  ).trim();
  const [, runs, failures] = counted.match(/loop n=(\d+) fail=(\d+)/) ?? [];
  assert.ok(Number(runs) > 0, counted);
  const errors = await read(page, 'tmp/errs').catch(() => '');
  assert.equal(Number(failures), 0, `${counted}\n${errors}`);
  const probe = await other.evaluate(() => {
    window.probe.running = false;
    return { reads: window.probe.reads, missing: window.probe.missing.slice(0, 5) };
  });
  assert.ok(probe.reads > 0);
  assert.deepEqual(probe.missing, []);
  assert.equal(await version(page), SHIPPED);
  assert.deepEqual(page.errors, []);
});

const COMMAND = [`${bash}/bin/bash.wasm`, `${bash}/bin/bash`];
const HOLD = 'slicc-test-hold';

function holdSecond(files, name) {
  const channel = new BroadcastChannel(name);
  const opened = [];
  let letGo;
  const released = new Promise((resolve) => {
    letGo = resolve;
  });
  globalThis.releaseHold = () => letGo();
  const create = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function (...args) {
    const root = await navigator.storage.getDirectory();
    const path = (await root.resolve(this))?.join('/');
    if (files.includes(path) && !opened.includes(path)) {
      opened.push(path);
      if (opened.length === files.length) {
        channel.postMessage(path);
        await released;
      }
    }
    return create.apply(this, args);
  };
  return true;
}

async function installerWorker(t) {
  const href = new URL('/installer.js', chrome.url).href;
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const found = targetInfos.filter(({ type, url }) => type === 'shared_worker' && url === href);
  assert.equal(found.length, 1, `installer workers: ${JSON.stringify(targetInfos)}`);
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: found[0].targetId,
    flatten: true,
  });
  t.after(() => chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}));
  return (expression) =>
    chrome.cdp
      .send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
      .then(({ result, exceptionDetails }) => {
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description);
        return result.value;
      });
}

test('the BIOS installer replaces a command in place while seven runs: an exec that starts while one of its wasm and glue is new and the other old runs one version whole', async (t) => {
  const page = await chrome.page(t);
  await bootOlder(page);
  chrome.overrides.set('/hold.html', '<!doctype html><title>hold</title>');
  const other = await page.tab();
  await other.goto('/hold.html');
  await other.evaluate(
    (name) =>
      new Promise((resolve) => {
        const { port } = new SharedWorker('/installer.js', 'slicc-installer');
        window.installer = { port, held: null, result: null };
        new BroadcastChannel(name).onmessage = ({ data }) => {
          window.installer.held = data;
        };
        port.onmessage = ({ data }) => {
          if ('progress' in data) return;
          if (data.id === 1) resolve(data);
          else window.installer.result = data;
        };
        port.postMessage({ id: 1, op: 'hello' });
      }),
    HOLD
  );
  const installer = await installerWorker(t);
  assert.equal(await installer(`(${holdSecond})(${JSON.stringify(COMMAND)}, '${HOLD}')`), true);
  deploy();
  await other.evaluate(() =>
    window.installer.port.postMessage({
      id: 2,
      op: 'packages',
      args: {
        from: new URL('/packages/package-lock.json', location.href).href,
        base: 'opt/slicc/base',
      },
    })
  );
  const held = await other.until(() => window.installer.held ?? window.installer.result);
  assert.ok(
    COMMAND.includes(held),
    `the installer wasn't held at bash's files: ${JSON.stringify(held)}`
  );
  await page.send('Page.bringToFront');
  await shows(page, prompt);
  await run(
    page,
    `clear; bash -c 'echo exec-ok' > /tmp/held 2>&1; echo "held-$((40 + 2)) exit=$?"`
  );
  const seen = await page
    .within(
      60000,
      async (root) => {
        const { dock } = document.querySelector('slicc-app');
        const terminal = dock.api.panels
          .map(({ id }) => id)
          .findLast((id) => id.startsWith('terminal:'));
        if (dock.content(terminal).screen.textContent.includes('held-42')) return 'answered';
        const { pending = [] } = await navigator.locks.query();
        const waiting = pending.some(({ name, mode }) => mode === 'shared' && name.includes(root));
        return waiting && 'waiting';
      },
      `/${bash}`
    )
    .catch((error) => {
      throw new Error(`the exec neither answered nor waited for the package: ${error.message}`);
    });
  await installer('globalThis.releaseHold()');
  const result = await other.until(() => window.installer.result);
  assert.ok(result.result?.downloaded >= 1, JSON.stringify(result));
  await shows(page, 'held-42', 120000);
  const output = await read(page, 'tmp/held').catch((error) => `no /tmp/held: ${error.message}`);
  assert.equal(output.trim(), 'exec-ok', `the exec (${seen} while ${held} was held): ${output}`);
  assert.match(await screen(page), /held-42 exit=0/);
  assert.equal(await version(page), SHIPPED);
  assert.deepEqual(page.errors, []);
});

test('the BIOS installer updates a command’s wasm before its glue and its package.json last, so another tab never sees new glue beside old wasm', async (t) => {
  const page = await chrome.page(t);
  await bootOlder(page);
  chrome.overrides.set('/order.html', '<!doctype html><title>order</title>');
  const other = await page.tab();
  await other.goto('/order.html');
  await other.evaluate((bash) => {
    const names = ['bin/bash.wasm', 'bin/bash', 'package.json'];
    const stamp = async () => {
      let dir = await navigator.storage.getDirectory();
      for (const part of bash.split('/')) dir = await dir.getDirectoryHandle(part);
      const out = [];
      for (const name of names) {
        let at = dir;
        const parts = name.split('/');
        const file = parts.pop();
        for (const part of parts) at = await at.getDirectoryHandle(part);
        out.push((await (await at.getFileHandle(file)).getFile()).lastModified);
      }
      return out;
    };
    window.order = { samples: 0, seen: [], wrong: [] };
    window.order.running = true;
    void (async () => {
      const first = await stamp();
      while (window.order.running) {
        const now = await stamp().catch(() => null);
        window.order.samples += 1;
        if (!now) continue;
        const changed = now.map((at, i) => at !== first[i]);
        const key = changed.map(Number).join('');
        if (!window.order.seen.includes(key)) window.order.seen.push(key);
        const [wasm, glue, manifest] = changed;
        if ((glue && !wasm) || (manifest && !(wasm && glue))) window.order.wrong.push(key);
      }
    })();
  }, bash);
  deploy();
  const result = await other.evaluate(
    () =>
      new Promise((resolve) => {
        const { port } = new SharedWorker('/installer.js', 'slicc-installer');
        port.onmessage = ({ data }) => {
          if ('progress' in data) return;
          resolve(data);
        };
        port.postMessage({
          id: 1,
          op: 'packages',
          args: {
            from: new URL('/packages/package-lock.json', location.href).href,
            base: 'opt/slicc/base',
          },
        });
      })
  );
  assert.ok(result.result?.downloaded >= 1, JSON.stringify(result));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const order = await other.evaluate(() => {
    window.order.running = false;
    return {
      samples: window.order.samples,
      seen: window.order.seen,
      wrong: window.order.wrong.slice(0, 5),
    };
  });
  assert.ok(order.samples > 0);
  assert.ok(
    order.seen.includes('111'),
    `the three files never all changed: ${JSON.stringify(order)}`
  );
  assert.deepEqual(
    order.wrong,
    [],
    `new glue or manifest beside old wasm: ${JSON.stringify(order)}`
  );
  assert.equal(await version(page), SHIPPED);
  assert.deepEqual(page.errors, []);
});
