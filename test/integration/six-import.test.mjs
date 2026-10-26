import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentUp, ready } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';
import { startWww } from './fake-six.mjs';

const chrome = await launch({ agent: true, timeout: 60000 });
const www = await startWww(new URL(chrome.url));
const { origin, state } = www;
const proxy = await fakeProxy({
  origin,
  key: 'the-key',
  answer: async (request) => {
    if (!request.url.startsWith('https://registry.npmjs.org/'))
      return { status: 404, headers: [], body: Buffer.alloc(0) };
    const type = request.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json';
    return { status: 200, headers: [['content-type', type]], body: await download(request.url) };
  },
});
after(async () => {
  await proxy.close();
  await www.close();
  await chrome.close();
});

const sh = (page, command) =>
  page.evaluate(async (command) => {
    const client = await globalThis.sliccKernelClient();
    const { status, stdout, stderr } = await client.run(['bash', '-c', command], { cwd: '/root' });
    return { status, out: `${stdout}${stderr}` };
  }, command);

async function moved(t, { dismissed = null } = {}) {
  const page = await chrome.page(t);
  await page.init(
    `() => { globalThis.sliccKernelDebug = true; if (location.origin === ${JSON.stringify(origin)} && !localStorage.getItem(${JSON.stringify(VAULT_KEY)})) localStorage.setItem(${JSON.stringify(VAULT_KEY)}, ${JSON.stringify(chrome.vault.origin)}); }`
  );
  await page.goto(`${origin}/`);
  await page.until(() => document.getElementById('six')?.dataset.ran === 'yes');
  if (dismissed) {
    await page.evaluate(
      (dismissed) => localStorage.setItem('slicc-os.notices.dismissed', JSON.stringify(dismissed)),
      dismissed
    );
  }
  await page.goto(`${origin}/7/#${new URLSearchParams({ proxy: proxy.url, key: 'the-key' })}`);
  await page.within(
    15 * 60 * 1000,
    () =>
      document.querySelector('.six')?.dataset.state === 'asking' &&
      document.querySelector('.six').open
  );
  await page.evaluate(() => document.querySelector('.six-move').click());
  await ready(page);
  const dir = await page.evaluate(() => localStorage.getItem('slicc-os.six-import'));
  assert.match(dir, /^\/slicc-v6-upgrade\/[0-9a-f-]{36}\/$/);
  await agentUp(page);
  return { page, dir };
}

const notice = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector('slicc-app')
        ?.model?.notices?.list()
        .find(({ id }) => id === 'six-import') ?? null
  );

const pressNotice = (page, selector) =>
  page.within(
    60000,
    (selector) => {
      const find = (root) => {
        const hit = root.querySelector(selector);
        if (hit) return hit;
        for (const node of root.querySelectorAll('*')) {
          const inner = node.shadowRoot && find(node.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      const target = find(document);
      if (!target?.getBoundingClientRect().width) return false;
      target.click();
      return true;
    },
    selector
  );

const listed = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector('slicc-app')
        ?.model?.notices?.list()
        .some(({ id }) => id === 'six-import') ?? false
  );

const still = (page) =>
  page.within(30000, () => {
    const seen = (globalThis.sliccShotFrames ??= new WeakMap());
    const frames = [];
    const walk = (root) => {
      for (const node of root.querySelectorAll('*')) {
        if (node.localName === 'iframe') frames.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);
    const now = performance.now();
    let ready = document.getAnimations().every((animation) => animation.playState !== 'running');
    for (const frame of frames) {
      if (!seen.has(frame)) {
        const entry = { found: now, loaded: null };
        frame.addEventListener('load', () => {
          entry.loaded = performance.now();
        });
        seen.set(frame, entry);
      }
      const { found, loaded } = seen.get(frame);
      if (now - found < 1000 || (loaded !== null && now - loaded < 300)) ready = false;
    }
    return ready;
  });

async function shots(page, name) {
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  const color = (want) =>
    page.evaluate((want) => {
      const shell = document.querySelector('slicc-app');
      if (shell.color !== want) shell.toggleColor();
      return shell.color;
    }, want);
  await color('light');
  await still(page);
  await page.screenshot(new URL(`${name}-light.png`, page.dir));
  await color('dark');
  await still(page);
  await page.screenshot(new URL(`${name}-dark.png`, page.dir));
  await color('light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app')?.screen === 'phone');
  await page.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await still(page);
  await page.screenshot(new URL(`${name}-420.png`, page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app')?.screen === 'desktop');
}

test('after the move, the agent imports the export in place: the files leave /slicc-fs, the export directory is deleted and the hand-off key goes', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  state.mode = 'ok';
  const { page, dir } = await moved(t);
  await page.within(5 * 60 * 1000, () => localStorage.getItem('slicc-os.six-import') === null);

  const after = await sh(
    page,
    `cat /root/v6/home-user/notes.txt; test ! -e /slicc-fs/home/user/notes.txt && echo gone-from-slicc-fs; test ! -e ${dir} && echo export-removed`
  );
  assert.equal(after.out, 'six notes\ngone-from-slicc-fs\nexport-removed\n', after.out);
  assert.equal(await notice(page), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six')), 'upgraded');
  assert.deepEqual(page.errors, []);
});

test('when the agent refuses the export, seven keeps the hand-off key, says so, leaves the files in /slicc-fs, and Stop trying drops the key for good', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  state.mode = 'tamper';
  const { page, dir } = await moved(t);
  const shown = await page.within(5 * 60 * 1000, () => {
    const found = document
      .querySelector('slicc-app')
      ?.model?.notices?.list()
      .find(({ id }) => id === 'six-import');
    return found ? { tone: found.tone, title: found.title, body: found.body } : null;
  });
  assert.equal(shown.tone, 'warning');
  assert.equal(shown.title, 'Your SLICC 6 cones aren’t in seven yet');
  assert.match(
    shown.body,
    /^Seven couldn’t import what SLICC 6 left in this browser: .+\. Seven tries again the next time it starts\. Stop trying leaves SLICC 6’s files where they are\.$/
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six-import')), dir);
  const kept = await sh(
    page,
    `cat /slicc-fs/home/user/notes.txt; test -e ${dir}manifest.json && echo export-kept; test ! -e /root/v6/home-user/notes.txt && echo not-moved`
  );
  assert.equal(kept.out, 'six notes\nexport-kept\nnot-moved\n', kept.out);
  await shots(page, 'six-import-failed');
  await pressNotice(page, '[data-notice="six-import"] [data-action="six-import-stop"]');
  await page.within(30000, () => localStorage.getItem('slicc-os.six-import') === null);
  assert.equal(await listed(page), false);
  await page.reload();
  await ready(page);
  await agentUp(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six-import')), null);
  assert.equal(await listed(page), false);
  const left = await sh(
    page,
    `cat /slicc-fs/home/user/notes.txt; test -e ${dir}manifest.json && echo export-kept`
  );
  assert.equal(left.out, 'six notes\nexport-kept\n', left.out);
  assert.deepEqual(page.errors, []);
});

test('when the export named by the hand-off key has no manifest.json, seven keeps the key and says so, even to someone who closed that notice for good before, moves nothing, closing the notice hides it only until the next start, and Stop trying then drops the key for good', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  state.mode = 'lost';
  const { page, dir } = await moved(t, { dismissed: ['six-import', 'unrelated'] });
  const shown = await page.within(5 * 60 * 1000, () => {
    const found = document
      .querySelector('slicc-app')
      ?.model?.notices?.list()
      .find(({ id }) => id === 'six-import');
    return found ? { body: found.body, actions: found.actions, session: found.session } : null;
  });
  assert.deepEqual(shown, {
    body: 'Seven couldn’t import what SLICC 6 left in this browser: SLICC 6’s export has no readable manifest.json. Seven tries again the next time it starts. Stop trying leaves SLICC 6’s files where they are.',
    actions: [{ id: 'six-import-stop', label: 'Stop trying' }],
    session: true,
  });
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six-import')), dir);
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('slicc-os.notices.dismissed'))),
    ['unrelated']
  );
  const kept = await sh(
    page,
    `cat /slicc-fs/home/user/notes.txt; test -d ${dir} && test ! -e ${dir}manifest.json && echo no-manifest; test ! -e /root/v6 && echo not-moved`
  );
  assert.equal(kept.out, 'six notes\nno-manifest\nnot-moved\n', kept.out);
  await pressNotice(page, '[data-notice="six-import"] [data-dismiss]');
  await page.within(30000, async () => {
    const shell = document.querySelector('slicc-app');
    return !shell.model.notices.list().some(({ id }) => id === 'six-import');
  });
  await page.reload();
  await ready(page);
  await agentUp(page);
  await page.within(5 * 60 * 1000, () =>
    document
      .querySelector('slicc-app')
      ?.model?.notices?.list()
      .some(({ id }) => id === 'six-import')
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six-import')), dir);
  await pressNotice(page, '[data-notice="six-import"] [data-action="six-import-stop"]');
  await page.within(30000, () => localStorage.getItem('slicc-os.six-import') === null);
  assert.equal(await listed(page), false);
  await page.reload();
  await ready(page);
  await agentUp(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six-import')), null);
  assert.equal(await listed(page), false);
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('slicc-os.notices.dismissed'))),
    ['unrelated']
  );
  const left = await sh(
    page,
    `test -d ${dir} && test ! -e ${dir}manifest.json && echo no-manifest`
  );
  assert.equal(left.out, 'no-manifest\n', left.out);
  assert.deepEqual(page.errors, []);
});
