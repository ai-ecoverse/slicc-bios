import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { debuggerUrl, devtools, launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
const { port: debugging } = await devtools(chrome);
after(() => chrome.close());
await debuggerUrl(debugging);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageWithWorker(t) {
  chrome.overrides.set(
    '/creator-worker.js',
    'self.onmessage = (e) => self.postMessage(e.data); self.postMessage("ready");'
  );
  chrome.overrides.set(
    '/creator-page.html',
    '<!doctype html><title>creator</title><script>window.w = new Worker("/creator-worker.js");</script>'
  );
  const blank = new URL('/creator-blank.html', chrome.url).href;
  chrome.overrides.set('/creator-blank.html', '<!doctype html><title>blank</title>');
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url: blank });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const { sessionId: page } = await chrome.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const seen = [];
  let worker;
  let workerTarget;
  const off = chrome.cdp.on((message) => {
    seen.push(message);
    if (
      message.method === 'Target.attachedToTarget' &&
      message.params?.targetInfo?.type === 'worker' &&
      (message.sessionId === page || message.sessionId === undefined)
    ) {
      worker = message.params.sessionId;
      workerTarget = message.params.targetInfo.targetId;
    }
  });
  t.after(() => off?.());
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
  await chrome.cdp.send(
    'Page.navigate',
    { url: new URL('/creator-page.html', chrome.url).href },
    page
  );
  const deadline = Date.now() + 15000;
  while (!worker && Date.now() < deadline) await wait(50);
  assert.ok(
    worker,
    `Chrome never auto-attached the dedicated worker: ${JSON.stringify(
      seen
        .filter((message) => message.method?.startsWith('Target.'))
        .map((message) => ({
          method: message.method,
          sessionId: message.sessionId,
          type: message.params?.targetInfo?.type,
          targetId: message.params?.targetInfo?.targetId ?? message.params?.targetId,
        }))
        .slice(-8)
    )}`
  );
  return { targetId, page, worker, workerTarget, seen };
}

async function evaluateOn(sessionId, expression = 'self.location.href') {
  return chrome.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId).then(
    (answer) => answer,
    (error) => ({ error: { message: error.message } })
  );
}

test('Chrome keeps a dedicated worker session after its parent page session is detached, and the worker dies with its document on navigation', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const { page, worker, workerTarget, seen } = await pageWithWorker(t);
  const beforeDetach = seen.length;
  await chrome.cdp.send('Target.detachFromTarget', { sessionId: page });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) await wait(50);
  const afterParent = seen.slice(beforeDetach);
  const workerDetachEvents = afterParent.filter(
    (message) =>
      message.method === 'Target.detachedFromTarget' && message.params?.sessionId === worker
  );
  const evaluateAfterParentDetach = await evaluateOn(worker);
  const workerStillListed = (await chrome.cdp.send('Target.getTargets')).targetInfos.some(
    (info) => info.targetId === workerTarget
  );
  const facts = {
    a_workerDetachEventAfterParentDetach: workerDetachEvents.length > 0,
    a_detachEvents: workerDetachEvents.map((message) => ({
      sessionId: message.sessionId,
      params: message.params,
    })),
    b_evaluateAfterParentDetach: evaluateAfterParentDetach.error
      ? { error: evaluateAfterParentDetach.error.message }
      : { value: evaluateAfterParentDetach.result?.result?.value },
    b_workerStillListedAfterParentDetach: workerStillListed,
  };
  t.diagnostic(`after parent page session detach: ${JSON.stringify(facts)}`);
  assert.equal(
    facts.a_workerDetachEventAfterParentDetach,
    false,
    `Chrome does not emit Target.detachedFromTarget for the auto-attached worker when its parent page session is detached: ${JSON.stringify(facts)}`
  );
  assert.equal(
    evaluateAfterParentDetach.error,
    undefined,
    `the worker session still answers after the parent page session is detached: ${JSON.stringify(facts)}`
  );
  assert.ok(
    workerStillListed,
    `the worker target stays listed after the parent page session is detached: ${JSON.stringify(facts)}`
  );

  const again = await pageWithWorker(t);
  const beforeNav = again.seen.length;
  await chrome.cdp.send(
    'Page.navigate',
    { url: new URL('/creator-page.html?after=1', chrome.url).href },
    again.page
  );
  const navDeadline = Date.now() + 10000;
  let workerGone = false;
  let workerDetachOnNav = false;
  while (Date.now() < navDeadline) {
    workerDetachOnNav = again.seen
      .slice(beforeNav)
      .some(
        (message) =>
          message.method === 'Target.detachedFromTarget' &&
          message.params?.sessionId === again.worker
      );
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    workerGone = !targetInfos.some((info) => info.targetId === again.workerTarget);
    if (workerGone || workerDetachOnNav) break;
    await wait(50);
  }
  const evaluateAfterNavigate = await evaluateOn(again.worker);
  const navFacts = {
    c_workerGoneFromGetTargets: workerGone,
    c_workerDetachEventOnNavigate: workerDetachOnNav,
    c_evaluateAfterNavigate: evaluateAfterNavigate.error
      ? { error: evaluateAfterNavigate.error.message }
      : { value: evaluateAfterNavigate.result?.result?.value },
  };
  t.diagnostic(`after creator document navigation: ${JSON.stringify(navFacts)}`);
  assert.ok(
    workerGone || workerDetachOnNav || evaluateAfterNavigate.error,
    `the dedicated worker dies with its document on navigation: ${JSON.stringify(navFacts)}`
  );
});
