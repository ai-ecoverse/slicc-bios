import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { debuggerUrl, devtools, launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
const { port: debugging } = await devtools(chrome);
after(() => chrome.close());
await debuggerUrl(debugging);

async function pageWithWorker(t) {
  chrome.overrides.set(
    '/creator-worker.js',
    'self.onmessage = (e) => self.postMessage(e.data); self.postMessage("ready");'
  );
  chrome.overrides.set(
    '/creator-page.html',
    '<!doctype html><title>creator</title><script>window.w = new Worker("/creator-worker.js");</script>'
  );
  const { targetId } = await chrome.cdp.send('Target.createTarget', {
    url: new URL('/creator-page.html', chrome.url).href,
  });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const { sessionId: page } = await chrome.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await chrome.cdp.send(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'worker' }],
    },
    page
  );
  const deadline = Date.now() + 15000;
  let worker;
  let workerTarget;
  const seen = [];
  const onEvent = (message) => {
    seen.push(message);
    if (
      message.method === 'Target.attachedToTarget' &&
      message.params?.targetInfo?.type === 'worker' &&
      message.sessionId === page
    ) {
      worker = message.params.sessionId;
      workerTarget = message.params.targetInfo.targetId;
    }
  };
  const previous = chrome.cdp.onmessage;
  chrome.cdp.onmessage = (text) => {
    previous?.(text);
    try {
      onEvent(JSON.parse(text));
    } catch {}
  };
  t.after(() => {
    chrome.cdp.onmessage = previous;
  });
  while (!worker && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    worker,
    `Chrome never auto-attached the dedicated worker: ${JSON.stringify(seen.slice(-5))}`
  );
  return { targetId, page, worker, workerTarget, seen };
}

test('Chrome detaches an auto-attached dedicated worker with its parent session, and the worker dies with its document on navigation', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const { page, worker, seen } = await pageWithWorker(t);
  const beforeDetach = seen.length;
  await chrome.cdp.send('Target.detachFromTarget', { sessionId: page });
  const deadline = Date.now() + 5000;
  let chromeDetachedWorker = false;
  while (Date.now() < deadline) {
    chromeDetachedWorker = seen
      .slice(beforeDetach)
      .some(
        (message) =>
          message.method === 'Target.detachedFromTarget' && message.params?.sessionId === worker
      );
    if (chromeDetachedWorker) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const evaluateAfterDetach = await chrome.cdp
    .send('Runtime.evaluate', { expression: '1', returnByValue: true }, worker)
    .then(
      (answer) => answer,
      (error) => ({ error: { message: error.message } })
    );
  assert.equal(
    chromeDetachedWorker,
    true,
    'Chrome emits Target.detachedFromTarget for the auto-attached worker when its parent session is detached'
  );
  assert.ok(
    evaluateAfterDetach.error,
    `a worker session cut with its parent answers no evaluate: ${JSON.stringify(evaluateAfterDetach)}`
  );

  const again = await pageWithWorker(t);
  await chrome.cdp.send(
    'Page.navigate',
    { url: new URL('/creator-page.html?after=1', chrome.url).href },
    again.page
  );
  const navDeadline = Date.now() + 10000;
  let workerGone = false;
  while (Date.now() < navDeadline) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    workerGone = !targetInfos.some((info) => info.targetId === again.workerTarget);
    if (workerGone) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(
    workerGone,
    true,
    'the dedicated worker target is gone after its document navigates'
  );
});
