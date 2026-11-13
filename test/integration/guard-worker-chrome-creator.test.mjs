import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensionConnection } from '../../src/seed/cdp.js';
import { guardProtected } from '../../src/seed/guard.js';
import { debuggerUrl, devtools, launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
const { port: debugging } = await devtools(chrome);
after(() => chrome.close());
await debuggerUrl(debugging);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const own = ['https://seven.invalid'];
const seed = fileURLToPath(new URL('../../src/seed/', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));

function evaluatedValue(answer) {
  return answer?.result?.result?.value ?? answer?.result?.value;
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
  return { targetId, page, worker, workerTarget, workerUrl, seen, stamp };
}

async function evaluateOn(sessionId, expression = 'self.location.href', cdp = chrome.cdp) {
  return cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId).then(
    (answer) => answer,
    (error) => ({ error: { message: error.message } })
  );
}

function kernelClient(t, guardFn) {
  const raw = extensionConnection(chrome.cdp);
  const guarded = guardFn(raw, own, new Map(), undefined, undefined, null);
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

async function mainGuardProtected() {
  const root = join(tmpdir(), `main-guard-${process.pid}-${Date.now()}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'seed'), { recursive: true });
  const base = process.env.GITHUB_BASE_REF || 'main';
  execFileSync('git', ['fetch', '--depth=1', 'origin', base], { cwd: repo, stdio: 'pipe' });
  const body = execFileSync('git', ['show', `origin/${base}:src/seed/guard.js`], {
    encoding: 'utf8',
    cwd: repo,
  });
  await writeFile(join(root, 'seed', 'guard.js'), body);
  for (const name of ['adobe.js', 'debugger.js', 'held.js']) {
    await symlink(join(seed, name), join(root, 'seed', name));
  }
  return (await import(`${pathToFileURL(join(root, 'seed', 'guard.js')).href}?t=${Date.now()}`))
    .guardProtected;
}

async function workerThroughKernel(t, guardFn) {
  const { got, send } = kernelClient(t, guardFn);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  await send(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'worker' }],
    },
    page
  );
  const before = got.length;
  await send('Page.navigate', { url: new URL(`/guard-page-${stamp}.html`, chrome.url).href }, page);
  const deadline = Date.now() + 15000;
  let worker;
  let workerTarget;
  while (Date.now() < deadline) {
    const event = got
      .slice(before)
      .find(
        (message) =>
          message.method === 'Target.attachedToTarget' &&
          message.params?.targetInfo?.type === 'worker'
      );
    if (event) {
      worker = event.params.sessionId;
      workerTarget = event.params.targetInfo.targetId;
      break;
    }
    await wait(50);
  }
  assert.ok(worker, `kernel client never saw the worker: ${JSON.stringify(got.slice(-8))}`);
  return { got, send, page, worker, workerTarget, beforeShown: got.length };
}

test('Chrome destroys a dedicated worker session with its parent page session, keeps the worker target listed until document navigation, and allows a browser-level reattach', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const { page, worker, workerTarget, workerUrl, seen } = await pageWithWorker(t);
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
    b_evaluateAfterParentDetach: evaluateAfterParentDetach.error
      ? { error: evaluateAfterParentDetach.error.message }
      : { value: evaluatedValue(evaluateAfterParentDetach) },
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
    evaluateAfterParentDetach.error?.message ?? '',
    /Session with given id not found/i,
    `(b) the old worker session is gone: ${JSON.stringify(facts)}`
  );
  assert.ok(workerStillListed, `(b) the worker target stays listed: ${JSON.stringify(facts)}`);
  assert.equal(
    reattach.error,
    undefined,
    `(d) browser-level Target.attachToTarget of the listed worker succeeds: ${JSON.stringify(facts)}`
  );
  assert.ok(fresh, `(d) a new worker session id is returned: ${JSON.stringify(facts)}`);
  assert.equal(
    evaluateAfterReattach.error,
    undefined,
    `(d) Runtime.evaluate on the new session answers: ${JSON.stringify(facts)}`
  );
  assert.equal(
    reattachHref,
    workerUrl,
    `(d) evaluate returns the worker URL: ${JSON.stringify(facts)}`
  );

  const again = await pageWithWorker(t);
  const beforeNav = again.seen.length;
  await chrome.cdp.send(
    'Page.navigate',
    { url: new URL(`/creator-page-${again.stamp}.html?after=1`, chrome.url).href },
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
    `(c) the dedicated worker dies with its document on navigation: ${JSON.stringify(navFacts)}`
  );
});

test('a kernel caller through #1536 cuts a browser-level reattach of a worker whose creator session was detached; main shows it', {
  timeout: 3 * 60 * 1000,
}, async (t) => {
  const branch = await workerThroughKernel(t, guardProtected);
  await branch.send('Target.detachFromTarget', { sessionId: branch.page });
  await wait(200);
  const beforeReattach = branch.got.length;
  const reattach = await branch.send('Target.attachToTarget', {
    targetId: branch.workerTarget,
    flatten: true,
  });
  const fresh = reattach.result?.sessionId;
  await wait(400);
  const shown = branch.got
    .slice(beforeReattach)
    .some(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        message.params?.sessionId === fresh &&
        message.params?.targetInfo?.targetId === branch.workerTarget
    );
  const evaluated = fresh
    ? await branch.send(
        'Runtime.evaluate',
        { expression: 'self.location.href', returnByValue: true },
        fresh
      )
    : { error: { message: reattach.error?.message ?? 'no session' } };
  const eBranch = {
    reattach: reattach.error ? { error: reattach.error.message } : { sessionId: fresh },
    shown,
    evaluate: evaluated.error
      ? { error: evaluated.error.message }
      : { value: evaluatedValue(evaluated) },
  };
  t.diagnostic(`(e) #1536 kernel after creator detach: ${JSON.stringify(eBranch)}`);
  assert.ok(
    reattach.error || !shown || evaluated.error,
    `(e) #1536 refuses or cuts the browser-level reattach and never shows it: ${JSON.stringify(eBranch)}`
  );
  assert.equal(
    shown,
    false,
    `(e) the reattached worker is never shown: ${JSON.stringify(eBranch)}`
  );

  const mainGuard = await mainGuardProtected();
  const main = await workerThroughKernel(t, mainGuard);
  await main.send('Target.detachFromTarget', { sessionId: main.page });
  await wait(200);
  const beforeMain = main.got.length;
  const mainReattach = await main.send('Target.attachToTarget', {
    targetId: main.workerTarget,
    flatten: true,
  });
  const mainFresh = mainReattach.result?.sessionId;
  await wait(400);
  const mainShown = main.got
    .slice(beforeMain)
    .some(
      (message) =>
        message.method === 'Target.attachedToTarget' &&
        (message.params?.sessionId === mainFresh ||
          message.params?.targetInfo?.targetId === main.workerTarget)
    );
  const mainEvaluated = mainFresh
    ? await main.send(
        'Runtime.evaluate',
        { expression: 'self.location.href', returnByValue: true },
        mainFresh
      )
    : { error: { message: mainReattach.error?.message ?? 'no session' } };
  const eMain = {
    reattach: mainReattach.error ? { error: mainReattach.error.message } : { sessionId: mainFresh },
    shown: mainShown,
    evaluate: mainEvaluated.error
      ? { error: mainEvaluated.error.message }
      : { value: evaluatedValue(mainEvaluated) },
  };
  t.diagnostic(`(e) main kernel after creator detach: ${JSON.stringify(eMain)}`);
  assert.equal(
    mainReattach.error,
    undefined,
    `(e) main still answers Target.attachToTarget for the listed worker: ${JSON.stringify(eMain)}`
  );
  assert.ok(
    mainShown || !mainEvaluated.error,
    `(e) main shows or answers on the reattached worker: ${JSON.stringify(eMain)}`
  );
});
