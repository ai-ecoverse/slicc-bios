import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { ready } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const LOST = 'BFCache exclusion lost: only the guard protects seven now';
const BLANKED = 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E';

const free = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const away = createHttp((request, response) => {
  response
    .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end('<!doctype html><title>elsewhere</title><p id="elsewhere">elsewhere</p>\n');
});
await new Promise((done) => away.listen(0, '127.0.0.1', done));
const elsewhere = `http://localhost:${away.address().port}/`;

const debugging = await free();
const chrome = await launch({ args: [`--remote-debugging-port=${debugging}`] });
const fakeExtension = extensionOver(await debuggerUrl(debugging));
after(async () => {
  await new Promise((done) => {
    away.close(done);
    away.closeAllConnections();
  });
  await chrome.close();
});

function reasons(tree) {
  if (!tree) return [];
  return [
    ...(tree.explanations ?? []).map(({ reason }) => reason),
    ...(tree.children ?? []).flatMap(reasons),
  ];
}

async function guarded() {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const connection = guardProtected(
    extensionConnection(globalThis.sliccExtension.cdp),
    self.origin
  );
  const pending = new Map();
  const events = [];
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else events.push(message);
  };
  window.agent = {
    events,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        next += 1;
        const id = next;
        const timer = setTimeout(
          () => resolve({ error: { message: `${method} got no answer` } }),
          15000
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      }),
  };
}

async function observed(sessionId, expression) {
  const { result } = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    sessionId
  );
  return result?.value;
}

async function until(what, check, ms = 60000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check().catch((error) => `error: ${error.message}`);
    if (last === true || (last && typeof last === 'object' && last.done)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what}: not within ${ms} ms, last ${JSON.stringify(last)}`);
}

test("over the guarded extension route, an agent's Back from an ordinary page to seven's /os/ finds no cached seven: Chrome reports seven's unload handler, the guard blocks the load, and nothing of seven reaches the agent", async (t) => {
  const page = await chrome.page(t);
  const extension = await fakeExtension(page);
  t.after(() => extension.close());
  await page.goto('/');
  await ready(page);
  await page.evaluate(guarded);

  const seven = new URL('os/', chrome.url).href;
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const mine = targetInfos.find(
    (info) => info.type === 'page' && info.url.startsWith(new URL('/', chrome.url).href)
  );
  assert.ok(mine?.browserContextId, `the test's own tab: ${JSON.stringify(targetInfos)}`);
  const { targetId } = await chrome.cdp.send('Target.createTarget', {
    url: seven,
    browserContextId: mine.browserContextId,
  });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await chrome.cdp.send('Page.enable', {}, sessionId);
  await chrome.cdp.send('Runtime.enable', {}, sessionId);
  const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, sessionId);
  const frame = frameTree.frame.id;
  const refused = [];
  const off = chrome.cdp.on(({ method, params, sessionId: from }) => {
    if (method === 'Page.backForwardCacheNotUsed' && from === sessionId && params.frameId === frame)
      refused.push(params);
  });
  t.after(off);

  await until('seven in the user tab', async () =>
    observed(
      sessionId,
      `location.pathname === '/os/' && document.readyState === 'complete' && !!document.querySelector('slicc-app')`
    )
  );
  await observed(sessionId, `window.sliccKept = 'kept'; true`);
  await chrome.cdp.send('Page.navigate', { url: elsewhere }, sessionId);
  await until('the ordinary page in the user tab', async () =>
    observed(
      sessionId,
      `!!document.getElementById('elsewhere') && document.readyState === 'complete'`
    )
  );

  const agent = await page.evaluate(async (targetId) => {
    const attached = await window.agent.send('Target.attachToTarget', { targetId, flatten: true });
    const session = attached.result?.sessionId ?? null;
    if (!session) return { attached, session };
    const enabled = await window.agent.send('Page.enable', {}, session);
    const back = await window.agent.send(
      'Runtime.evaluate',
      { expression: 'history.back(); true', returnByValue: true },
      session
    );
    return { session, enabled: !enabled.error, back };
  }, targetId);
  assert.ok(agent.session, `the agent attached to the ordinary tab: ${JSON.stringify(agent)}`);
  assert.equal(agent.back.error, undefined, `the agent's Back ran: ${JSON.stringify(agent.back)}`);

  const landed = await until('the Back to reach the blocked page or a fresh /os/', async () => {
    const at = JSON.parse(
      await observed(
        sessionId,
        `JSON.stringify({ href: location.href, ready: document.readyState, kept: window.sliccKept ?? null, type: performance.getEntriesByType('navigation')[0]?.type ?? null })`
      )
    );
    return (at.href === BLANKED || at.href === seven) && at.ready === 'complete'
      ? { done: true, ...at }
      : at;
  });
  t.diagnostic(`after the agent's Back the user tab is at ${landed.href}`);
  const found = refused.flatMap(({ notRestoredExplanations = [], notRestoredExplanationsTree }) => [
    ...notRestoredExplanations.map(({ type, reason }) => `${type}:${reason}`),
    ...reasons(notRestoredExplanationsTree).map((reason) => `tree:${reason}`),
  ]);
  t.diagnostic(
    `back/forward cache refused seven's /os/ on the extension route: ${found.join(', ') || 'nothing'}`
  );
  assert.equal(landed.kept, null, LOST);
  assert.equal(refused.length, 1, LOST);
  assert.ok(
    refused[0].notRestoredExplanations?.some(
      ({ reason }) => reason === 'UnloadHandlerExistsInMainFrame'
    ),
    LOST
  );
  assert.ok(
    landed.href === BLANKED || landed.href === seven,
    `the Back went somewhere unexpected: ${landed.href}`
  );

  const after = await page.evaluate(async (session) => {
    const read = await window.agent.send(
      'Runtime.evaluate',
      { expression: 'document.documentElement.outerHTML', returnByValue: true },
      session
    );
    const told = window.agent.events.filter(
      (message) => message.method === 'Page.backForwardCacheNotUsed'
    );
    return { read, told };
  }, agent.session);
  t.diagnostic(
    `the guarded stream saw ${after.told.length} backForwardCacheNotUsed, and the read answered ${JSON.stringify(after.read).slice(0, 200)}`
  );
  for (const told of after.told) {
    assert.ok(
      told.params?.notRestoredExplanations?.some(
        ({ reason }) => reason === 'UnloadHandlerExistsInMainFrame'
      ),
      LOST
    );
  }
  if (landed.href === BLANKED) {
    assert.equal(
      after.read.result?.result?.value,
      '<html><head><title>blocked</title></head><body></body></html>',
      `the agent read more than the blocked page: ${JSON.stringify(after.read).slice(0, 300)}`
    );
  } else {
    assert.ok(
      after.read.error,
      `the guard read seven's document: ${JSON.stringify(after.read).slice(0, 300)}`
    );
  }
  assert.doesNotMatch(JSON.stringify(after.read), /slicc-app/);
  assert.deepEqual(page.errors, []);
});
