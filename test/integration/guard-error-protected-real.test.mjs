import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { CURRENT_EXTENSION, realExtension, SEVEN } from './real-extension.mjs';

const site = createServer((req, res) => {
  const frame = new URL(req.url, 'http://host.invalid').searchParams.get('frame');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<!doctype html><title>host</title><p id="mark">host</p><iframe src="${frame ?? 'about:blank'}"></iframe>`
  );
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
after(() => site.close());
const host = (frame) =>
  `http://127.0.0.1:${site.address().port}/host?frame=${encodeURIComponent(frame)}`;
const ORDINARY_FAILED = 'http://unreachable.test/frame';
const PROTECTED_FAILED = 'https://www.sliccy.ai/auth/callback?code=error-protected-secret';
const RULES = ['MAP unreachable.test 127.0.0.1:9', 'MAP www.sliccy.ai 127.0.0.1:9'];

async function install() {
  globalThis.errorGuard?.close();
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const extension = globalThis.sliccExtension;
  const connection = guardProtected(
    extensionConnection(extension.cdp),
    location.origin,
    new Map(),
    { kind: 'extension', version: extension.version },
    (targetId) => extension.frames(Number(targetId))
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

async function rawFrames(real, url) {
  const { targetInfos } = await real.cdp.send('Target.getTargets');
  const target = targetInfos.find((info) => info.type === 'page' && info.url === url);
  if (!target) return null;
  const { sessionId } = await real.cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  try {
    const tree = await real.cdp.send('Page.getFrameTree', {}, sessionId);
    const { result } = await real.cdp.send(
      'Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true },
      sessionId
    );
    return { tree: tree.frameTree, state: result.value, targets: targetInfos };
  } finally {
    await real.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

async function errored(real, url) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    last = await rawFrames(real, url);
    const child = last?.tree?.childFrames?.[0]?.frame;
    const remote = last?.targets?.find(
      (info) => info.type === 'iframe' && info.url.startsWith('chrome-error:')
    );
    if (last?.state === 'complete' && (child?.url?.startsWith('chrome-error:') || remote))
      return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`the iframe never failed: ${JSON.stringify(last)?.slice(0, 2000)}`);
}

async function opened(t, frame) {
  const real = await realExtension({ extension: CURRENT_EXTENSION, rules: RULES });
  t.after(() => real.close());
  const seven = await real.page(t);
  await seven.goto(SEVEN);
  await ready(seven);
  t.after(() => seven.evaluate(() => globalThis.errorGuard?.close()).catch(() => {}));
  const url = host(frame);
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
  return { seven, sessionId: attached.result.sessionId };
}

test(`over the real extension ${CURRENT_EXTENSION.version}, a page whose ordinary cross-site iframe failed to load is drivable through the guard`, {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const { seven, sessionId } = await opened(t, ORDINARY_FAILED);
  const deadline = Date.now() + 30000;
  let read;
  while (Date.now() < deadline) {
    read = await guarded(seven, 'DOM.getDocument', { depth: 1 }, sessionId);
    if (!read.error) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(read.error, undefined, `DOM.getDocument stayed refused: ${JSON.stringify(read)}`);
  assert.equal(read.result.root.nodeName, '#document');
  const mark = await guarded(
    seven,
    'Runtime.evaluate',
    { expression: 'document.getElementById("mark").textContent', returnByValue: true },
    sessionId
  );
  assert.equal(mark.result?.result?.value, 'host', JSON.stringify(mark));
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
