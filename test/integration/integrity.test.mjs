import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, eventually, ready, run, shows, watch } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const model = 'node_modules/@ai-ecoverse/slicc-spectrum/dist/slicc-kernel-model.js';

async function read(page, path) {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const names = path.split('/');
    const name = names.pop();
    for (const part of names) dir = await dir.getDirectoryHandle(part);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test('seven refuses its own code once a kernel process changes it, puts it back and says so', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await run(
    page,
    `echo 'globalThis.__changed = "os";' >> /os/tabs.js && echo 'globalThis.__changed = "spectrum";' >> /${model} && echo changed-$((40 + 2))`
  );
  await shows(page, 'changed-42');
  assert.match(await read(page, 'os/tabs.js'), /__changed/);

  chrome.cdn.requests.length = 0;
  const bios = await watch(page);
  await page.reload();
  await ready(page);
  await eventually(() => assert.ok(bios.states().includes('navigate:done')));
  const said = [...bios.texts('packages'), ...bios.texts('seed')].filter((text) =>
    text.endsWith('put back')
  );
  assert.ok(said.length >= 1, said.join('\n'));
  assert.ok(chrome.cdn.requests.some((url) => url.includes('/slicc-spectrum/-/')));

  assert.equal(await page.evaluate(() => globalThis.__changed ?? null), null);
  assert.doesNotMatch(await read(page, 'os/tabs.js'), /__changed/);
  assert.doesNotMatch(await read(page, model), /__changed/);
  const notices = await page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .map(({ tone, title, body }) => ({ tone, title, body }))
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].tone, 'warning');
  assert.equal(notices[0].title, 'Seven’s files were changed');
  assert.match(
    notices[0].body,
    /changed after seven installed (it|them)\. Seven didn’t run the changed code/
  );
  const shown = () => {
    const deep = (root) => {
      const found = root.querySelector('[data-notice^="repaired:"]');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    document.querySelector('slicc-app').show('chat');
    return !!deep(document);
  };
  await page.until(shown);
  await page.screenshot(new URL('integrity-notice-light.png', page.dir));
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color !== 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('integrity-notice-dark.png', page.dir));
  await page.evaluate(() => document.querySelector('slicc-app').toggleColor());
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => document.querySelector('slicc-app').screen === 'phone');
  await page.until(shown);
  await page.screenshot(new URL('integrity-notice-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => document.querySelector('slicc-app').screen === 'desktop');
  assert.deepEqual(page.errors, []);
});
