import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, shows } from './bios.mjs';
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

  await a.close();
  await b.within(
    30000,
    () => document.querySelector('slicc-app').model.tabs?.state().role === 'owner'
  );
  await shows(b, 'the tab running SLICC closed');
  await b.until(() => {
    const { dock } = document.querySelector('slicc-app');
    const id = dock.api.panels.map((panel) => panel.id).findLast((p) => p.startsWith('terminal:'));
    const text = dock.content(id).screen.textContent;
    return text.slice(text.lastIndexOf('the tab running SLICC closed')).includes('slicc:');
  });
  await run(b, 'echo after-$((40+4))');
  await shows(b, 'after-44', 30000);
  await run(b, 'cat /tmp/pr17');
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
