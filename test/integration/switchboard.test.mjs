import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const LOCK = 'pr17-switchboard-test';

async function own(page, bios) {
  return page.evaluate(
    async (lock, bios) => {
      const tabs = await import('/os/tabs.js');
      const { createKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      const claimed = await tabs.claim(navigator.locks, lock);
      const board = await tabs.joinSwitchboard({ versions: { bios } });
      const root = await navigator.storage.getDirectory();
      const start = async () => {
        const kernel = await createKernel({ root, media: false });
        board.own(async () => ({ kernel: await kernel.connect() }));
        window.pr17 = { ...window.pr17, kernel, owned: true };
        return kernel;
      };
      window.pr17 = { board, owned: false, out: '', stalls: 0 };
      board.on('stalled', () => {
        window.pr17.stalls += 1;
      });
      if (!claimed.owner) {
        void claimed.next.then(start);
        return false;
      }
      const kernel = await start();
      await kernel.run(['sh', '-c', 'echo from-the-owner > /tmp/pr17-owner']);
      return true;
    },
    LOCK,
    bios
  );
}

test('a follower tab uses the owner tab kernel, and its terminal moves on when the owner goes', async (t) => {
  const a = await chrome.page(t);
  await boot(a);
  const b = await a.tab();
  await boot(b);
  assert.equal(await own(a, 'a'), true);
  assert.equal(await own(b, 'b'), false);
  const followed = await b.evaluate(async () => {
    const tabs = await import('/os/tabs.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const { board } = window.pr17;
    const following = tabs.followKernel({
      port: async () => (await board.ports()).kernel,
      attach: attachKernel,
    });
    const decoder = new TextDecoder();
    const terminal = await following.openTerminal(['bash', '-i'], {
      cwd: '/home',
      cols: 80,
      rows: 24,
      onData: (bytes) => {
        window.pr17.out += decoder.decode(bytes);
      },
    });
    Object.assign(window.pr17, { following, terminal });
    const read = await following.run(['cat', '/tmp/pr17-owner']);
    return { owner: board.owner(), stdout: read.stdout };
  });
  assert.deepEqual(followed.owner.versions, { bios: 'a' });
  assert.equal(followed.stdout, 'from-the-owner\n');

  await a.evaluate(() => {
    window.pr17.sleeper = window.pr17.kernel.openTerminal(['sleep', '300'], { cols: 80, rows: 24 });
  });
  const pid = await b.until(async () => {
    const list = await window.pr17.following.ps();
    return list.find((entry) => entry.argv.join(' ') === 'sleep 300')?.pid;
  });
  await b.evaluate((pid) => window.pr17.following.kill(pid, 'SIGTERM'), pid);
  assert.notEqual(await a.evaluate(async () => (await window.pr17.sleeper).exited), null);

  await b.evaluate(() => window.pr17.terminal.write('echo before-$((40+2))\n'));
  await b.until(() => window.pr17.out.includes('before-42'));
  await a.close();
  await b.within(15000, () => window.pr17.owned);
  await b.until(() => window.pr17.out.includes('the tab running SLICC closed'));
  await b.until(() => window.pr17.board.owner()?.versions?.bios === 'b');
  await b.evaluate(() => window.pr17.terminal.write('echo after-$((40+3))\n'));
  await b.within(15000, () => window.pr17.out.includes('after-43'));
  assert.deepEqual(b.errors, []);
});

test('followers hear that a frozen owner stalls, and that it answers again', async (t) => {
  const a = await chrome.page(t);
  await boot(a);
  const b = await a.tab();
  await boot(b);
  assert.equal(await own(a, 'a'), true);
  assert.equal(await own(b, 'b'), false);
  await b.until(() => window.pr17.board.owner()?.tab);
  await a.send('Page.setWebLifecycleState', { state: 'frozen' });
  const started = Date.now();
  await b.within(10000, () => window.pr17.stalls === 1);
  const stalledAfter = Date.now() - started;
  const unstalled = b.evaluate(
    () =>
      new Promise((resolve) => {
        window.pr17.board.on('unstalled', () => resolve(true));
      })
  );
  await a.send('Page.setWebLifecycleState', { state: 'active' });
  assert.equal(await unstalled, true);
  console.log(`stalled after ${stalledAfter} ms of a frozen owner`);
  assert.ok(stalledAfter <= 7000, `${stalledAfter} ms`);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});
