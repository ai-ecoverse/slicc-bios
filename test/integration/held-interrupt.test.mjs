import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ timeout: 120000 });
after(() => chrome.close());

const HOOK = `(() => {
  const state = (globalThis.sliccHeld = { armed: false, bash: 0, shell: undefined, child: undefined, forking: 0, release: false, open: 0, closed: 0 });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  globalThis[Symbol.for('slicc-kernel.test.syscall')] = async ({ pid, op }) => {
    if (!state.armed) return;
    if (op === 'proc-fork' && pid === state.bash && state.shell === undefined) {
      state.shell = pid;
      state.forking = Date.now();
      for (let waited = 0; !state.release && waited < 10000; waited += 10) await sleep(10);
      return;
    }
    if (state.shell !== undefined && pid !== state.shell && state.child === undefined && op === 'proc-setpgid') {
      state.child = pid;
      state.open = Date.now();
      await sleep(300);
      state.closed = Date.now();
    }
  };
  return 'hooked';
})()`;

async function kernelWorker() {
  for (let tries = 0; tries < 100; tries += 1) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find(
      (info) => info.type === 'worker' && /kernel-worker\.js/.test(info.url)
    );
    if (found) {
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId: found.targetId,
        flatten: true,
      });
      return sessionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no kernel worker target');
}

const inWorker = async (session, expression) =>
  (
    await chrome.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      session
    )
  ).result.value;

test('smoke: a ^C pressed while the terminal bash forks a foreground job reaches that job, and the shell lives on and runs the next command (homescoop#1230; the kernel’s settling-inherited row is the deterministic proof)', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const session = await kernelWorker();
  assert.equal(await inWorker(session, HOOK), 'hooked');
  await run(page, 'clear; echo "bash-pid=[$$]-$((40 + 2))"');
  await shows(page, ']-42', 60000);
  const bash = Number((await screen(page)).match(/bash-pid=\[(\d+)\]/)?.[1]);
  assert.ok(bash > 0, 'the terminal shell printed its pid');
  await inWorker(session, `globalThis.sliccHeld.bash = ${bash}; globalThis.sliccHeld.armed = true`);
  await run(page, 'sleep 1 && echo ran-$((40 + 2))');
  const held = async () =>
    JSON.parse(await inWorker(session, 'JSON.stringify(globalThis.sliccHeld)'));
  let forking = await held();
  for (let tries = 0; tries < 400 && !forking.forking; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    forking = await held();
  }
  assert.ok(forking.forking, `bash reached proc-fork: ${JSON.stringify(forking)}`);
  for (const type of ['keyDown', 'keyUp'])
    await page.send('Input.dispatchKeyEvent', {
      type,
      key: 'c',
      code: 'KeyC',
      modifiers: 2,
      windowsVirtualKeyCode: 67,
    });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await inWorker(session, 'globalThis.sliccHeld.release = true');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  t.diagnostic(JSON.stringify(await held()));
  await inWorker(session, 'globalThis.sliccHeld.armed = false');
  await run(page, 'echo after-$((40 + 2))');
  await shows(page, 'after-42', 60000).catch(async (error) => {
    throw new Error(
      `the shell did not run the next command: ${error.message}\n${await screen(page)}`
    );
  });
  assert.doesNotMatch(await screen(page), /ran-42/);
  assert.deepEqual(page.errors, []);
});
