import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

const served = [];
const REFUSING = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'content-type': 'text/html',
};
const site = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  served.push(`${req.headers.host} ${url.pathname}`);
  if (url.pathname === '/host') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><title>host</title><p id="mark">host</p>${url.searchParams
        .getAll('frame')
        .map((frame) => `<iframe src="${frame}"></iframe>`)
        .join('')}`
    );
    return;
  }
  if (url.pathname === '/doc') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>sibling</title><p>ordinary sibling</p>');
    return;
  }
  res.writeHead(200, REFUSING);
  res.end('<!doctype html><title>refused frame</title><p>never framed</p>');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
after(() => site.close());
const port = site.address().port;
const FRAME_HOST = 'refusing-frames.test';
const SIBLING_HOST = 'other.test';
const host = (...frames) =>
  `http://127.0.0.1:${port}/host?${frames.map((frame) => `frame=${encodeURIComponent(frame)}`).join('&')}`;
const ORDINARY_FAILED = `http://${FRAME_HOST}/refused/frame`;
const PROTECTED_FAILED = `http://${FRAME_HOST}/auth/callback?code=error-protected-secret`;
const UNREACHABLE = 'https://127.0.0.1:1/unreachable/frame?q=probe';
const SIBLING = `http://${SIBLING_HOST}/doc?sibling=probe`;
const RULES = [`MAP ${FRAME_HOST} 127.0.0.1:${port}`];
const VARIANT_RULES = [...RULES, `MAP ${SIBLING_HOST} 127.0.0.1:${port}`];
const OBSERVE = 120000;
const probe = (line) =>
  process.stdout.write(
    `PROBE ${JSON.stringify({ run: process.env.PROBE_RUN ?? null, ...line })}\n`
  );

async function install() {
  globalThis.errorGuard?.close();
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const extension = globalThis.sliccExtension;
  const answers = [];
  globalThis.errorGuardFrames = answers;
  const shape = (answer) => {
    if (!answer || typeof answer !== 'object') return `answer ${typeof answer}`;
    const kinds = Array.isArray(answer.frames)
      ? answer.frames
          .map((frame) =>
            frame?.kind === 'error' ? `error:${frame.errorProtected}` : String(frame?.kind)
          )
          .sort()
          .join(',')
      : 'none';
    return `v${answer.version} frames=[${kinds}] local=${answer.localFrames?.length} remote=${answer.remoteOwners?.length}`;
  };
  const frames = (targetId) => {
    const entry = { targetId, calledAt: Date.now() };
    answers.push(entry);
    let call;
    try {
      call = extension.frames(Number(targetId));
    } catch (error) {
      entry.settledAt = Date.now();
      entry.text = `threw: ${error?.message ?? String(error)}`;
      throw error;
    }
    Promise.resolve(call).then(
      (answer) => {
        entry.settledAt = Date.now();
        entry.text = shape(answer);
      },
      (error) => {
        entry.settledAt = Date.now();
        entry.text = `rejected: ${error?.message ?? String(error)}`;
      }
    );
    return call;
  };
  const connection = guardProtected(
    extensionConnection(extension.cdp),
    location.origin,
    new Map(),
    { kind: 'extension', version: extension.version },
    frames
  );
  const pending = new Map();
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} got no answer within 60 s` } });
      }, 60000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  globalThis.errorGuard = { close: () => connection.close(), send };
}

const guarded = (seven, method, params, sessionId) =>
  seven.evaluate(
    ([method, params, sessionId]) =>
      globalThis.errorGuard.send(method, params, sessionId ?? undefined),
    [method, params, sessionId ?? null]
  );

const walk = (node) => [node.frame, ...(node.childFrames ?? []).flatMap(walk)];
const failedFrame = (frame) =>
  Boolean(frame?.unreachableUrl) || String(frame?.url ?? '').startsWith('chrome-error:');
const brief = (frame) => ({
  id: frame.id,
  parentId: frame.parentId,
  url: frame.url,
  unreachableUrl: frame.unreachableUrl,
});

async function treeOf(real, targetId) {
  const { sessionId } = await real.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    return (await real.cdp.send('Page.getFrameTree', {}, sessionId)).frameTree;
  } finally {
    await real.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

async function look(real, url) {
  const { targetInfos } = await real.cdp.send('Target.getTargets');
  const page = targetInfos.find((info) => info.type === 'page' && info.url === url);
  if (!page) return { page: null };
  const local = walk(await treeOf(real, page.targetId)).slice(1);
  const iframes = targetInfos.filter(
    (info) => info.type === 'iframe' && info.parentId === page.targetId
  );
  const remote = [];
  for (const info of iframes)
    remote.push(
      ...(await treeOf(real, info.targetId).then(walk, (error) => [
        { id: info.targetId, url: `unreadable: ${error.message}` },
      ]))
    );
  return {
    page: page.targetId,
    local: local.map(brief),
    iframes: iframes.map(({ targetId, url }) => ({ targetId, url })),
    remote: remote.map(brief),
  };
}

async function errored(real, url) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    last = await look(real, url).catch((error) => ({ error: error.message }));
    if ([...(last.local ?? []), ...(last.remote ?? [])].some(failedFrame)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(
    `the refused iframe never reached Chrome's error page within 30000 ms: saw ${JSON.stringify({ ...last, served })}`
  );
}

async function opened(t, frame, rules = RULES) {
  const real = await realExtension({ extension: CURRENT_EXTENSION, rules });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  t.after(() => seven.evaluate(() => globalThis.errorGuard?.close()).catch(() => {}));
  const url = host(...[frame].flat());
  const createdAt = Date.now();
  await real.cdp.send('Target.createTarget', { url });
  await errored(real, url);
  await seven.evaluate(install);
  const listed = await guarded(seven, 'Target.getTargets', {});
  const tab = listed.result?.targetInfos?.find((info) => info.url === url);
  assert.ok(tab, `the host tab is listed through the guard: ${JSON.stringify(listed)}`);
  const attached = await guarded(seven, 'Target.attachToTarget', {
    targetId: tab.targetId,
    flatten: true,
  });
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  return { real, seven, sessionId: attached.result.sessionId, createdAt, targetId: tab.targetId };
}

function tally(map, text, ms) {
  const seen = map.get(text) ?? { text, count: 0, firstSeenMs: ms };
  seen.count += 1;
  seen.lastSeenMs = ms;
  map.set(text, seen);
}

async function unlocks(t, fixture, frame, rules) {
  const { real, seven, sessionId, createdAt, targetId } = await opened(t, frame, rules);
  const browser = await real.cdp.send('Browser.getVersion').catch((error) => ({
    error: error.message,
  }));
  const extensionVersion = await seven.evaluate(() => globalThis.sliccExtension?.version);
  probe({
    probe: 'env',
    fixture,
    product: browser.product ?? browser.error,
    revision: browser.revision,
    extension: extensionVersion,
    pinned: CURRENT_EXTENSION.version,
  });
  const started = Date.now();
  const refusals = new Map();
  let attempts = 0;
  let read;
  let unlockedAfterMs = null;
  let unlockAttemptStartMs = null;
  while (Date.now() < started + OBSERVE) {
    const at = Date.now() - started;
    attempts += 1;
    read = await guarded(seven, 'DOM.getDocument', { depth: 1 }, sessionId);
    if (!read.error) {
      unlockedAfterMs = Date.now() - started;
      unlockAttemptStartMs = at;
      break;
    }
    tally(refusals, read.error.message ?? JSON.stringify(read.error), at);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const answers = await seven
    .evaluate(() => globalThis.errorGuardFrames ?? [])
    .catch((error) => [{ calledAt: started, text: `unreadable: ${error.message}` }]);
  const distinct = new Map();
  for (const entry of answers)
    tally(distinct, entry.text ?? 'pending', (entry.settledAt ?? entry.calledAt) - started);
  const outcome =
    unlockAttemptStartMs === null
      ? `locked-${OBSERVE / 1000}s`
      : unlockAttemptStartMs < 30000
        ? 'unlocked'
        : 'unlocked-late';
  probe({
    probe: 'unlock',
    fixture,
    attempts,
    refusedTexts: [...refusals.keys()],
    refusals: [...refusals.values()],
    firstAttemptMs: started - createdAt,
    unlockedAfterMs,
    unlockAttemptStartMs,
    lockedPast10s: unlockedAfterMs === null || unlockedAfterMs > 10000,
    lockedPast30s: unlockedAfterMs === null || unlockedAfterMs > 30000,
    outcome,
  });
  probe({
    probe: 'frames',
    fixture,
    targetId,
    calls: answers.length,
    distinct: [...distinct.values()],
    timeline: answers.slice(0, 200).map((entry) => ({
      calledMs: entry.calledAt - started,
      settledMs: entry.settledAt === undefined ? null : entry.settledAt - started,
      targetMatches: String(entry.targetId) === String(targetId),
      text: entry.text ?? 'pending',
    })),
  });
  assert.notEqual(
    unlockAttemptStartMs,
    null,
    `DOM.getDocument stayed refused for ${OBSERVE} ms: ${JSON.stringify(read)}`
  );
  assert.ok(
    unlockAttemptStartMs < 30000,
    `DOM.getDocument stayed refused past 30000 ms, unlocked after ${unlockedAfterMs} ms`
  );
  assert.equal(read.result.root.nodeName, '#document');
  const mark = await guarded(
    seven,
    'Runtime.evaluate',
    { expression: 'document.getElementById("mark").textContent', returnByValue: true },
    sessionId
  );
  assert.equal(mark.result?.result?.value, 'host', JSON.stringify(mark));
}

test(`over the real extension ${CURRENT_EXTENSION.version}, a page whose ordinary cross-site iframe failed to load is drivable through the guard`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  await unlocks(t, 'ordinary-refused', ORDINARY_FAILED);
});

test(`probe: over the real extension ${CURRENT_EXTENSION.version}, a page with an unreachable https://127.0.0.1:1 iframe and an ordinary other.test sibling is drivable through the guard`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  await unlocks(t, 'unreachable-with-sibling', [UNREACHABLE, SIBLING], VARIANT_RULES);
});

test(`over the real extension ${CURRENT_EXTENSION.version}, a page whose iframe failed to load a protected sign-in callback stays locked for DOM and paint`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const { seven, sessionId } = await opened(t, PROTECTED_FAILED);
  for (let n = 0; n < 10; n++) {
    for (const [method, params] of [
      ['DOM.getDocument', { depth: 1 }],
      ['Page.captureScreenshot', {}],
    ]) {
      const answer = await guarded(seven, method, params, sessionId);
      assert.match(
        answer.error?.message ?? '',
        /^slicc: refused: /,
        `${method}: ${JSON.stringify(answer)}`
      );
      assert.doesNotMatch(JSON.stringify(answer), /error-protected-secret/);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
