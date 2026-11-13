import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { guardProtected } from '../../src/seed/guard.js';
import { debuggerUrl, devtools, launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
const { port: debugging } = await devtools(chrome);
after(() => chrome.close());
await debuggerUrl(debugging);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const own = ['https://seven.invalid'];

function evaluatedValue(answer) {
  return answer?.result?.result?.value ?? answer?.result?.value;
}

async function until(done, ms, label, saw) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await done()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${label}; saw: ${JSON.stringify(saw?.() ?? null)}`);
}

async function pageWithWorker(t, cdp = chrome.cdp) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workerUrl = new URL(`/creator-worker-${stamp}.js`, chrome.url).href;
  chrome.overrides.set(
    `/creator-worker-${stamp}.js`,
    'self.onmessage = (e) => self.postMessage(e.data); self.postMessage("ready");'
  );
  chrome.overrides.set(
    `/creator-page-${stamp}.html`,
    `<!doctype html><title>creator</title><script>window.w = new Worker("/creator-worker-${stamp}.js");</script>`
  );
  const blank = new URL(`/creator-blank-${stamp}.html`, chrome.url).href;
  chrome.overrides.set(`/creator-blank-${stamp}.html`, '<!doctype html><title>blank</title>');
  const { targetId } = await cdp.send('Target.createTarget', { url: blank });
  t.after(() => cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const { sessionId: page } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const seen = [];
  let worker;
  let workerTarget;
  const off = cdp.on((message) => {
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
  await cdp.send(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'worker' }],
    },
    page
  );
  await cdp.send(
    'Page.navigate',
    { url: new URL(`/creator-page-${stamp}.html`, chrome.url).href },
    page
  );
  await until(
    () => worker,
    15000,
    'Chrome auto-attach of the dedicated worker',
    () =>
      seen
        .filter((message) => message.method?.startsWith('Target.'))
        .map((message) => ({
          method: message.method,
          sessionId: message.sessionId,
          type: message.params?.targetInfo?.type,
          targetId: message.params?.targetInfo?.targetId ?? message.params?.targetId,
        }))
        .slice(-8)
  );
  return { targetId, page, worker, workerTarget, workerUrl, seen, stamp };
}

async function evaluateOn(sessionId, expression = 'self.location.href', cdp = chrome.cdp) {
  return cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId).then(
    (answer) => answer,
    (error) => ({ error: { message: error.message } })
  );
}

function kernelClient(t) {
  const raw = extensionConnection(chrome.cdp);
  const guarded = guardProtected(raw, own, new Map(), undefined, undefined, null);
  const got = [];
  const pending = new Map();
  let next = 0;
  guarded.onmessage = (text) => {
    const message = JSON.parse(text);
    got.push(message);
    if (message.id !== undefined) pending.get(message.id)?.(message);
  };
  t.after(() => guarded.close?.());
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++next;
      const timer = setTimeout(() => resolve({ error: { message: `${method} timed out` } }), 20000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      });
      guarded.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { got, send };
}

function shownWorker(got, from, workerTarget, sessionId) {
  return got
    .slice(from)
    .find(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.params?.targetInfo?.targetId === workerTarget &&
        (sessionId === undefined || message.params?.sessionId === sessionId)
    );
}

async function workerThroughKernel(t) {
  const { got, send } = kernelClient(t);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workerUrl = new URL(`/guard-worker-${stamp}.js`, chrome.url).href;
  chrome.overrides.set(
    `/guard-worker-${stamp}.js`,
    'self.onmessage = (e) => self.postMessage(e.data); self.postMessage("ready");'
  );
  chrome.overrides.set(
    `/guard-page-${stamp}.html`,
    `<!doctype html><title>guarded</title><script>window.w = new Worker("/guard-worker-${stamp}.js");</script>`
  );
  chrome.overrides.set(`/guard-blank-${stamp}.html`, '<!doctype html><title>blank</title>');
  const created = await send('Target.createTarget', {
    url: new URL(`/guard-blank-${stamp}.html`, chrome.url).href,
  });
  assert.equal(created.error, undefined, `createTarget: ${JSON.stringify(created)}`);
  const targetId = created.result.targetId;
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  assert.equal(attached.error, undefined, `attach page: ${JSON.stringify(attached)}`);
  const page = attached.result.sessionId;
  const auto = await send(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'worker' }],
    },
    page
  );
  assert.equal(auto.error, undefined, `setAutoAttach: ${JSON.stringify(auto)}`);
  const before = got.length;
  const navigated = await send(
    'Page.navigate',
    { url: new URL(`/guard-page-${stamp}.html`, chrome.url).href },
    page
  );
  assert.equal(navigated.error, undefined, `Page.navigate: ${JSON.stringify(navigated)}`);
  let worker;
  let workerTarget;
  await until(
    () => {
      const event = got
        .slice(before)
        .find(
          (message) =>
            message.method === 'Target.attachedToTarget' &&
            message.params?.targetInfo?.type === 'worker'
        );
      if (!event) return false;
      worker = event.params.sessionId;
      workerTarget = event.params.targetInfo.targetId;
      return true;
    },
    15000,
    'kernel auto-attach of the dedicated worker',
    () => got.slice(-8)
  );
  return { got, send, page, worker, workerTarget, workerUrl, targetId };
}

async function attachWorkerById(client, workerTarget) {
  const before = client.got.length;
  const answer = await client.send('Target.attachToTarget', {
    targetId: workerTarget,
    flatten: true,
  });
  const sessionId = answer.result?.sessionId;
  let shown = false;
  if (!answer.error && sessionId) {
    await until(
      () => {
        shown = Boolean(shownWorker(client.got, before, workerTarget, sessionId));
        return shown;
      },
      5000,
      `attachedToTarget for worker ${workerTarget}`,
      () => ({
        answer,
        recent: client.got.slice(before).map((message) => ({
          method: message.method,
          sessionId: message.params?.sessionId,
          targetId: message.params?.targetInfo?.targetId,
          error: message.error?.message,
        })),
      })
    );
  } else {
    shown = Boolean(shownWorker(client.got, before, workerTarget, sessionId));
  }
  const evaluated = sessionId
    ? await client.send(
        'Runtime.evaluate',
        { expression: 'self.location.href', returnByValue: true },
        sessionId
      )
    : { error: { message: answer.error?.message ?? 'no session' } };
  return {
    answer,
    sessionId,
    shown,
    evaluate: evaluated.error
      ? { error: evaluated.error.message }
      : { value: evaluatedValue(evaluated) },
  };
}

async function workerListed(send, workerTarget) {
  const listed = await send('Target.getTargets');
  assert.equal(listed.error, undefined, `getTargets: ${JSON.stringify(listed)}`);
  return Boolean(listed.result?.targetInfos?.some((info) => info.targetId === workerTarget));
}

test('Chrome destroys a dedicated worker session with its parent page session, keeps the worker target listed until document navigation, and allows a browser-level reattach', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const { page, worker, workerTarget, workerUrl, seen } = await pageWithWorker(t);
  const beforeDetach = seen.length;
  await chrome.cdp.send('Target.detachFromTarget', { sessionId: page });
  let afterDetachEvaluate = await evaluateOn(worker);
  await until(
    async () => {
      afterDetachEvaluate = await evaluateOn(worker);
      return Boolean(afterDetachEvaluate.error);
    },
    5000,
    'old worker session to stop answering after parent detach',
    () => afterDetachEvaluate
  ).catch(() => {});
  const afterParent = seen.slice(beforeDetach);
  const workerDetachEvents = afterParent.filter(
    (message) =>
      message.method === 'Target.detachedFromTarget' && message.params?.sessionId === worker
  );
  const workerStillListed = (await chrome.cdp.send('Target.getTargets')).targetInfos.some(
    (info) => info.targetId === workerTarget
  );
  const reattach = await chrome.cdp
    .send('Target.attachToTarget', { targetId: workerTarget, flatten: true })
    .then(
      (result) => result,
      (error) => ({ error: { message: error.message } })
    );
  const fresh = reattach.sessionId;
  const evaluateAfterReattach = fresh
    ? await evaluateOn(fresh, 'self.location.href')
    : { error: { message: reattach.error?.message ?? 'no session' } };
  if (fresh)
    t.after(() => chrome.cdp.send('Target.detachFromTarget', { sessionId: fresh }).catch(() => {}));
  const reattachHref = evaluatedValue(evaluateAfterReattach);
  const facts = {
    a_workerDetachEventAfterParentDetach: workerDetachEvents.length > 0,
    a_detachEvents: workerDetachEvents.map((message) => ({
      sessionId: message.sessionId,
      params: message.params,
    })),
    b_evaluateAfterParentDetach: afterDetachEvaluate.error
      ? { error: afterDetachEvaluate.error.message }
      : { value: evaluatedValue(afterDetachEvaluate) },
    b_workerStillListedAfterParentDetach: workerStillListed,
    d_reattachAfterParentDetach: reattach.error
      ? { error: reattach.error.message }
      : { sessionId: fresh },
    d_evaluateAfterReattach: evaluateAfterReattach.error
      ? { error: evaluateAfterReattach.error.message }
      : { value: reattachHref },
    d_workerUrl: workerUrl,
  };
  t.diagnostic(`after parent page session detach: ${JSON.stringify(facts)}`);
  assert.equal(
    facts.a_workerDetachEventAfterParentDetach,
    false,
    `(a) no Target.detachedFromTarget for the worker: ${JSON.stringify(facts)}`
  );
  assert.match(
    afterDetachEvaluate.error?.message ?? '',
    /Session with given id not found/i,
    `(b) the old worker session is gone: ${JSON.stringify(facts)}`
  );
  assert.ok(workerStillListed, `(b) the worker target stays listed: ${JSON.stringify(facts)}`);
  t.diagnostic(
    `(d) raw Chrome browser-level reattach after parent detach (informational): ${JSON.stringify({
      reattach: facts.d_reattachAfterParentDetach,
      evaluate: facts.d_evaluateAfterReattach,
      workerUrl,
    })}`
  );

  const again = await pageWithWorker(t);
  const beforeNav = again.seen.length;
  await chrome.cdp.send(
    'Page.navigate',
    { url: new URL(`/creator-page-${again.stamp}.html?after=1`, chrome.url).href },
    again.page
  );
  let workerGone = false;
  let workerDetachOnNav = false;
  await until(
    async () => {
      workerDetachOnNav = again.seen
        .slice(beforeNav)
        .some(
          (message) =>
            message.method === 'Target.detachedFromTarget' &&
            message.params?.sessionId === again.worker
        );
      const { targetInfos } = await chrome.cdp.send('Target.getTargets');
      workerGone = !targetInfos.some((info) => info.targetId === again.workerTarget);
      return workerGone || workerDetachOnNav;
    },
    10000,
    'worker to die with its document on navigation',
    () => ({
      workerGone,
      workerDetachOnNav,
      workerTarget: again.workerTarget,
    })
  ).catch(() => {});
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
    `(c) the dedicated worker dies with its document on navigation: ${JSON.stringify(navFacts)}`
  );
});

test('a kernel caller through the guard refuses a browser-level reattach only after its creator session is detached', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const cut = await workerThroughKernel(t);
  assert.ok(cut.worker, 'auto-attached worker session id');
  assert.ok(cut.workerTarget, 'auto-attached worker target id');
  const autoEvaluate = await cut.send(
    'Runtime.evaluate',
    { expression: 'self.location.href', returnByValue: true },
    cut.worker
  );
  assert.equal(
    autoEvaluate.error,
    undefined,
    `(e) auto-attached worker evaluates: ${JSON.stringify(autoEvaluate)}`
  );
  assert.equal(
    evaluatedValue(autoEvaluate),
    cut.workerUrl,
    `(e) auto-attached worker returns its URL: ${JSON.stringify(autoEvaluate)}`
  );
  assert.ok(
    await workerListed(cut.send, cut.workerTarget),
    `(e) worker target is listed before creator detach`
  );

  const pageDetach = await cut.send('Target.detachFromTarget', { sessionId: cut.page });
  assert.equal(
    pageDetach.error,
    undefined,
    `(e) detach creator page session: ${JSON.stringify(pageDetach)}`
  );
  await until(
    () =>
      cut.got.some(
        (message) =>
          message.method === 'Target.detachedFromTarget' && message.params?.sessionId === cut.page
      ),
    5000,
    'creator page session detachedFromTarget',
    () => cut.got.slice(-8)
  );
  await until(
    async () => {
      const { targetInfos } = await chrome.cdp.send('Target.getTargets');
      return targetInfos.some((info) => info.targetId === cut.workerTarget);
    },
    5000,
    'Chrome still lists the worker target after creator page detach',
    () => ({ workerTarget: cut.workerTarget })
  );

  const afterCut = await attachWorkerById(cut, cut.workerTarget);
  t.diagnostic(`(e) after creator detach: ${JSON.stringify(afterCut)}`);
  assert.ok(
    afterCut.answer.error,
    `(e) after creator detach, attachToTarget by id is refused: ${JSON.stringify(afterCut)}`
  );
  assert.equal(
    afterCut.shown,
    false,
    `(e) after creator detach, the worker is never shown: ${JSON.stringify(afterCut)}`
  );
  assert.ok(
    afterCut.evaluate.error,
    `(e) after creator detach, evaluate is refused: ${JSON.stringify(afterCut)}`
  );

  const control = await workerThroughKernel(t);
  const controlEvaluate = await control.send(
    'Runtime.evaluate',
    { expression: 'self.location.href', returnByValue: true },
    control.worker
  );
  assert.equal(
    controlEvaluate.error,
    undefined,
    `(e) control auto-attached worker evaluates: ${JSON.stringify(controlEvaluate)}`
  );
  assert.ok(
    await workerListed(control.send, control.workerTarget),
    `(e) control worker target is listed while its creator is fine`
  );
  const ordinary = await attachWorkerById(control, control.workerTarget);
  t.diagnostic(`(e) ordinary worker whose creator is not cut: ${JSON.stringify(ordinary)}`);
  assert.equal(
    ordinary.answer.error,
    undefined,
    `(e) an ordinary worker still attaches by id: ${JSON.stringify(ordinary)}`
  );
  assert.equal(
    ordinary.shown,
    true,
    `(e) an ordinary worker is still shown: ${JSON.stringify(ordinary)}`
  );
  assert.equal(
    ordinary.evaluate.error,
    undefined,
    `(e) an ordinary worker evaluate answers: ${JSON.stringify(ordinary)}`
  );
  assert.equal(
    ordinary.evaluate.value,
    control.workerUrl,
    `(e) an ordinary worker still evaluates: ${JSON.stringify(ordinary)}`
  );
});
