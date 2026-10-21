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

async function moved(t) {
  const page = await chrome.page(t);
  await page.init(
    `() => { globalThis.sliccKernelDebug = true; if (location.origin === ${JSON.stringify(origin)} && !localStorage.getItem(${JSON.stringify(VAULT_KEY)})) localStorage.setItem(${JSON.stringify(VAULT_KEY)}, ${JSON.stringify(chrome.vault.origin)}); }`
  );
  await page.goto(`${origin}/`);
  await page.until(() => document.getElementById('six')?.dataset.ran === 'yes');
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

test('when the agent refuses the export, seven keeps the hand-off key, says so, and leaves the files in /slicc-fs', {
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
    /^Seven couldn’t import what SLICC 6 left in this browser: .+\. Seven tries again the next time it starts\.$/
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six-import')), dir);
  const kept = await sh(
    page,
    `cat /slicc-fs/home/user/notes.txt; test -e ${dir}manifest.json && echo export-kept; test ! -e /root/v6/home-user/notes.txt && echo not-moved`
  );
  assert.equal(kept.out, 'six notes\nexport-kept\nnot-moved\n', kept.out);
  assert.deepEqual(page.errors, []);
});

test('when the export named by the hand-off key has no manifest.json, seven keeps the key, says so, and moves nothing', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  state.mode = 'lost';
  const { page, dir } = await moved(t);
  const shown = await page.within(5 * 60 * 1000, () => {
    const found = document
      .querySelector('slicc-app')
      ?.model?.notices?.list()
      .find(({ id }) => id === 'six-import');
    return found?.body ?? null;
  });
  assert.equal(
    shown,
    'Seven couldn’t import what SLICC 6 left in this browser: SLICC 6’s export has no readable manifest.json. Seven tries again the next time it starts.'
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six-import')), dir);
  const kept = await sh(
    page,
    `cat /slicc-fs/home/user/notes.txt; test -d ${dir} && test ! -e ${dir}manifest.json && echo no-manifest; test ! -e /root/v6 && echo not-moved`
  );
  assert.equal(kept.out, 'six notes\nno-manifest\nnot-moved\n', kept.out);
  assert.deepEqual(page.errors, []);
});
