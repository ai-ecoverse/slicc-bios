import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eventually, ready, run, shows, watch } from './bios.mjs';
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
  await page.goto('/#users=off');
  await ready(page);
  await run(
    page,
    `echo 'globalThis.__changed = "os";' >> /os/tabs.js && echo 'globalThis.__changed = "spectrum";' >> /${model} && rm /os/present.js && echo changed-$((40 + 2))`
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
  assert.match(await read(page, 'os/present.js'), /export/);
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

test('seven stops restoring a file that changes again right after it put it back, logs it and says so', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/#users=off');
  await ready(page);
  const bios = await watch(page);
  await run(page, `echo 'globalThis.__changed = 1;' >> /os/callback.js && echo first-$((40 + 2))`);
  await shows(page, 'first-42');
  await page.evaluate(() => {
    window.stale = true;
    void fetch('/os/callback.js');
  });
  await page.until(() => !window.stale && location.pathname === '/os/');
  await ready(page);
  await eventually(() => assert.ok(bios.states().includes('navigate:done')));
  assert.doesNotMatch(await read(page, 'os/callback.js'), /__changed/);

  await run(page, `echo 'globalThis.__changed = 2;' >> /os/callback.js && echo second-$((40 + 2))`);
  await shows(page, 'second-42');
  const refused = await page.evaluate(async () => {
    const response = await fetch('/os/callback.js');
    return [response.status, await response.text()];
  });
  assert.deepEqual(refused, [
    500,
    'sw: /os/callback.js keeps changing, so seven stopped restoring it\n',
  ]);
  const stopped = () =>
    document
      .querySelector('slicc-app')
      .model.notices.list()
      .find(({ id }) => id === 'stopped:/os/callback.js')?.body;
  assert.equal(
    await page.until(stopped),
    'Seven keeps finding /os/callback.js changed. It stopped restoring it and won’t run it. Something on this computer may be changing seven’s files.'
  );
  assert.match(await read(page, 'os/callback.js'), /__changed = 2/);
  const lines = (await read(page, 'var/log/slicc/integrity.log'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter(({ path }) => path === '/os/callback.js');
  assert.deepEqual(
    lines.map(({ event }) => event),
    ['changed', 'restored', 'stopped']
  );
  for (const line of lines) assert.match(line.expected, /^[0-9a-f]{64}$/);
  assert.notEqual(lines[0].actual, lines[2].actual);

  await page.reload();
  await ready(page);
  await page.until(stopped);
  await page.until(() => {
    const deep = (root) => {
      const found = root.querySelector('[data-notice^="stopped:"]');
      if (found) return found;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && deep(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    document.querySelector('slicc-app').show('chat');
    return !!deep(document);
  });
  await page.evaluate(() => {
    const app = document.querySelector('slicc-app');
    if (app.color === 'dark') app.toggleColor();
  });
  await page.screenshot(new URL('integrity-stopped-light.png', page.dir));
  assert.match(await read(page, 'os/callback.js'), /__changed = 2/);
  assert.deepEqual(page.errors, []);
});

test('a UI whose own code keeps changing says so instead of staying blank', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/#users=off');
  await ready(page);
  const bios = await watch(page);
  await run(page, `echo 'globalThis.__changed = 3;' >> /os/os.js && echo first-$((40 + 2))`);
  await shows(page, 'first-42');
  await page.reload();
  await ready(page);
  await eventually(() => assert.ok(bios.states().includes('navigate:done')));
  assert.doesNotMatch(await read(page, 'os/os.js'), /__changed/);
  await run(page, `echo 'globalThis.__changed = 4;' >> /os/os.js && echo second-$((40 + 2))`);
  await shows(page, 'second-42');
  await page.reload();
  const shown = await page.until(() => {
    const box = document.querySelector('[data-refused]');
    return (
      box && {
        path: location.pathname,
        title: box.querySelector('h1').textContent,
        text: box.querySelector('p').textContent,
        button: box.querySelector('button').textContent,
      }
    );
  });
  assert.deepEqual(shown, {
    path: '/os/',
    title: 'Seven couldn’t start',
    text: 'One of seven’s files, /os/os.js, keeps changing, so seven stopped putting it back and won’t run it. Seven tries again in about 10 minutes. Reload after that.',
    button: 'Reload',
  });
  assert.equal(await page.evaluate(() => globalThis.__changed ?? null), null);
  const scheme = (value) =>
    page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    });
  await scheme('light');
  await page.screenshot(new URL('integrity-refused-light.png', page.dir));
  await scheme('dark');
  await page.screenshot(new URL('integrity-refused-dark.png', page.dir));
  await scheme('light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.screenshot(new URL('integrity-refused-420.png', page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await scheme('');
  assert.deepEqual(page.errors, []);
});
