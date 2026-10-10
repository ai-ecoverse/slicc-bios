import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const role = (page) => page.evaluate(() => document.querySelector('slicc-app').model.tabs?.state());

test('a second tab follows the first on one kernel, and takes over when the first closes', async (t) => {
  const a = await chrome.page(t);
  await boot(a);
  const b = await a.tab();
  await boot(b);
  await a.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'owner');
  await b.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'follower');
  assert.deepEqual(await role(b), { role: 'follower', stalled: false, skew: null });

  await run(a, 'echo from-the-owner > /tmp/pr17; sleep 300 &');
  await run(b, 'cat /tmp/pr17');
  await shows(b, 'from-the-owner');
  await run(b, 'pgrep -f "sleep 300" > /dev/null && echo seen-$((40+2))');
  await shows(b, 'seen-42');
  await run(b, 'pkill -f "sleep 300"; pgrep -f "sleep 300" || echo gone-$((40+3))');
  await shows(b, 'gone-43');

  await b.send('Page.bringToFront');
  await a.close();
  await run(b, 'echo once-$((20+2))');
  await b.within(
    30000,
    () => document.querySelector('slicc-app').model.tabs?.state().role === 'owner'
  );
  await shows(b, 'SLICC closed');
  await shows(b, 'once-22', 30000);
  const text = await screen(b);
  assert.equal(text.split('echo once-$((20+2))').length, 2, text);
  assert.doesNotMatch(text, /slicc:\s*\[the tab running SLICC closed/);
  await run(b, 'echo after-$((40+4))');
  await shows(b, 'after-44', 30000);
  assert.deepEqual(b.errors, []);
});

test('a follower hears that a frozen owner stalls, and that it answers again', async (t) => {
  const a = await chrome.page(t);
  await boot(a);
  const b = await a.tab();
  await boot(b);
  await b.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'follower');
  await a.send('Page.setWebLifecycleState', { state: 'frozen' });
  await b.within(10000, () => document.querySelector('slicc-app').model.tabs.state().stalled);
  await a.send('Page.setWebLifecycleState', { state: 'active' });
  await b.within(10000, () => !document.querySelector('slicc-app').model.tabs.state().stalled);
  assert.deepEqual(await role(a), { role: 'owner', stalled: false, skew: null });
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});

test('each tab sizes its own shell: the owner at 1280, a follower at 420 with Chat open', async (t) => {
  const a = await chrome.page(t);
  await boot(a);
  const b = await a.tab();
  await boot(b);
  await b.until(() => document.querySelector('slicc-app').model.tabs?.state().role === 'follower');
  const size = (page) =>
    page.evaluate(() => {
      const { dock } = document.querySelector('slicc-app');
      const id = dock.api.panels
        .map((panel) => panel.id)
        .findLast((p) => p.startsWith('terminal:'));
      const { rows, cols } = dock.content(id).screen;
      return `${rows} ${cols}`;
    });
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await b.until(() => document.querySelector('slicc-app').screen === 'phone');
  await b.evaluate(() => document.querySelector('slicc-app').show('chat'));
  await a.send('Page.bringToFront');
  const wide = await size(a);
  await run(a, 'stty size; echo a-$((1+1))');
  await shows(a, 'a-2');
  assert.match(await screen(a), new RegExp(`stty size; echo a-\\$\\(\\(1\\+1\\)\\)\\s+${wide}`));
  await b.send('Page.bringToFront');
  await b.evaluate(() => document.querySelector('slicc-app').show('terminal'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const narrow = await size(b);
  assert.notEqual(narrow, wide);
  await run(b, 'stty size; echo b-$((1+2))');
  await shows(b, 'b-3');
  assert.match(await screen(b), new RegExp(`\\s${narrow}\\s`));
  await a.send('Page.bringToFront');
  await run(a, 'stty size; echo a-$((2+2))');
  await shows(a, 'a-4');
  assert.match(await screen(a), new RegExp(`echo a-\\$\\(\\(2\\+2\\)\\)\\s+${wide}`));
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});
