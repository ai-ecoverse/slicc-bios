import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { agentUp, ready } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';
import { fakeProxy } from './fake-proxy.mjs';
import { startWww } from './fake-six.mjs';

const chrome = await launch({ agent: true, timeout: 60000 });
const www = await startWww(new URL(chrome.url));
const { origin } = www;
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

test('after the move, the agent imports the export in place: the files leave /slicc-fs, the export directory is deleted and the hand-off key goes', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
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
      !document.querySelector('.six').hidden
  );
  await page.evaluate(() => document.querySelector('.six-move').click());
  await ready(page);
  const dir = await page.evaluate(() => localStorage.getItem('slicc-os.six-import'));
  assert.match(dir, /^\/slicc-v6-upgrade\/[0-9a-f-]{36}\/$/);
  await agentUp(page);
  await page.within(5 * 60 * 1000, () => localStorage.getItem('slicc-os.six-import') === null);

  const moved = await sh(
    page,
    `cat /root/v6/home-user/notes.txt; test ! -e /slicc-fs/home/user/notes.txt && echo gone-from-slicc-fs; test ! -e ${dir} && echo export-removed`
  );
  assert.equal(moved.out, 'six notes\ngone-from-slicc-fs\nexport-removed\n', moved.out);
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('slicc-app')
        ?.model?.notices?.list()
        .some(({ id }) => id === 'six-import')
    ),
    false
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.six')), 'upgraded');
  assert.deepEqual(page.errors, []);
});
