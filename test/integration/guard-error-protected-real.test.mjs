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
      `<!doctype html><title>host</title><p id="mark">host</p><iframe src="${url.searchParams.get('frame')}"></iframe>`
    );
    return;
  }
  res.writeHead(200, REFUSING);
  res.end('<!doctype html><title>refused frame</title><p>never framed</p>');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
after(() => site.close());
const port = site.address().port;
const FRAME_HOST = 'refusing-frames.test';
const host = (frame) => `http://127.0.0.1:${port}/host?frame=${encodeURIComponent(frame)}`;
const ORDINARY_FAILED = `http://${FRAME_HOST}/refused/frame`;
const PROTECTED_FAILED = `http://${FRAME_HOST}/auth/callback?code=error-protected-secret`;
const RULES = [`MAP ${FRAME_HOST} 127.0.0.1:${port}`];

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
