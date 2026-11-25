import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { guardProtected, PROTECTED, UNANSWERED, UNGUARDED } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';
import { devtools, launch } from './chrome.mjs';
import {
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-ordering-fixture.mjs';
import { guardRoute } from './guard-route.mjs';

const EXTENSION_UNANSWERED =
  "slicc: refused: this tab's page isn't answering, so the guard couldn't check its frames; a dialog may be waiting in the tab";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const [label, cause, refusal] of [
  ['the extension says the page is not answering', EXTENSION_UNANSWERED, UNANSWERED],
  [
    'the extension refuses for another reason',
    "slicc: refused: target is on seven's origin",
    UNGUARDED,
  ],
]) {
  test(`a private attach that fails because ${label} is refused as ${refusal === UNANSWERED ? 'not answering' : 'unguarded'}`, async (t) => {
    const p = protocol(t);
    p.target('ordinary');
    p.hold((message) => message.id >= 2 ** 30 && message.method === 'Target.attachToTarget');
    const attaching = p.send('Target.attachToTarget', { targetId: 'ordinary', flatten: true });
    for (let n = 0; n < 50 && !p.held.length; n += 1) await flush();
    p.release(p.held[0], { error: { code: -32000, message: cause } });
    assert.equal((await attaching).error?.message, refusal);
  });
}

test('a private session whose setup never answers is refused as not answering', {
  timeout: 30000,
}, async (t) => {
  const p = protocol(t);
  p.target('ordinary');
  p.hold((message) => message.id >= 2 ** 30 && message.method === 'Page.enable');
  const started = Date.now();
  const answer = await p.send('Target.attachToTarget', { targetId: 'ordinary', flatten: true });
  assert.equal(answer.error?.message, UNANSWERED);
  assert.ok(Date.now() - started < 20000);
});

const NAV_MS = 10000;
const at = (id, url) => ({ ...plainFrame(id), url, securityOrigin: new URL(url).origin });
const setup = (message) => message.id >= 2 ** 30 && message.method === 'Page.enable';
const SEVEN_PAGE = `${protectedOrigin}/os/`;
const VAULT_PAGE = 'https://vault.sliccy.ai/';

async function attachTimed(p, targetId) {
  const started = Date.now();
  const answer = await p.send('Target.attachToTarget', { targetId, flatten: true });
  return {
    error: answer.error?.message,
    sessionId: answer.result?.sessionId,
    ms: Date.now() - started,
  };
}

async function whileHeld(p) {
  for (let n = 0; n < 200 && !p.held.length; n += 1) await flush();
  assert.ok(p.held.length, 'the guard sent its setup');
}

const guardSession = (p, targetId) =>
  [...p.sessions].find(([id, target]) => target === targetId && id.startsWith('guard'))?.[0];

for (const [label, url] of [
  ['seven', SEVEN_PAGE],
  ['the vault', VAULT_PAGE],
]) {
  test(`a tab on ${label} whose guard setup would go unanswered is refused as protected at once`, async (t) => {
    const p = protocol(t);
    p.target('protected', 'page', at('protected', url));
    p.hold(setup);
    const answer = await attachTimed(p, 'protected');
    assert.equal(answer.error, PROTECTED);
    assert.equal(p.held.length, 0, 'the guard never armed a protected tab');
  });
}

test('a held sign-in tab whose guard setup would go unanswered is refused as protected at once', async (t) => {
  const p = protocol(t);
  p.target('sign-in-held', 'page', at('sign-in-held', 'https://ordinary.invalid/login'));
  hold('sign-in-held');
  p.hold(setup);
  const answer = await attachTimed(p, 'sign-in-held');
  assert.equal(answer.error, PROTECTED);
  assert.equal(p.held.length, 0);
});

for (const [label, url] of [
  ['seven', SEVEN_PAGE],
  ['the vault', VAULT_PAGE],
]) {
  test(`a tab that moves onto ${label} while its Page.enable is held is refused as protected, never as not answering`, {
    timeout: 30000,
  }, async (t) => {
    const p = protocol(t);
    const entry = p.target('moved', 'page', at('moved', ordinary));
    p.hold(setup);
    const attaching = attachTimed(p, 'moved');
    await whileHeld(p);
    entry.info.url = url;
    entry.tree.frame = at('moved', url);
    p.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    assert.equal((await attaching).error, PROTECTED);
  });

  test(`a tab still loading onto ${label} while its Page.enable is held is refused as protected, never as not answering`, {
    timeout: 30000,
  }, async (t) => {
    const p = protocol(t);
    p.target('loading', 'page', at('loading', ordinary));
    p.hold(setup);
    const attaching = attachTimed(p, 'loading');
    await whileHeld(p);
    p.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: guardSession(p, 'loading'),
      params: { frameId: 'loading', url, loaderId: 'next', navigationType: 'differentDocument' },
    });
    assert.equal((await attaching).error, PROTECTED);
  });
}

test('an ordinary tab still loading an ordinary page while its Page.enable is held is refused as not answering', {
  timeout: 30000,
}, async (t) => {
  const p = protocol(t);
  p.target('loading', 'page', at('loading', ordinary));
  p.hold(setup);
  const attaching = attachTimed(p, 'loading');
  await whileHeld(p);
  p.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: guardSession(p, 'loading'),
    params: {
      frameId: 'loading',
      url: 'https://ordinary.invalid/next',
      loaderId: 'next',
      navigationType: 'differentDocument',
    },
  });
  assert.equal((await attaching).error, UNANSWERED);
});

for (const how of ['errors', 'times out']) {
  test(`an ordinary-looking tab whose fresh target read ${how} after its setup went unanswered is refused as protected, never as not answering`, {
    timeout: 30000,
  }, async (t) => {
    const p = protocol(t);
    p.target('ordinary', 'page', at('ordinary', ordinary));
    p.hold(setup);
    const attaching = attachTimed(p, 'ordinary');
    await whileHeld(p);
    const reads = [];
    p.hold((message) => {
      if (message.id < 2 ** 30 || message.method !== 'Target.getTargetInfo') return false;
      reads.push(message);
      return true;
    });
    for (let n = 0; n < 400 && !reads.length; n += 1) await pause(50);
    assert.ok(reads.length, 'the guard read the target again before answering');
    if (how === 'errors')
      p.release(reads[0], { error: { code: -32000, message: 'synthetic read failure' } });
    assert.equal((await attaching).error, PROTECTED);
  });
}

test('a nav that settled ok is never marked unanswered once its timer would have fired', {
  timeout: 30000,
}, async (t) => {
  const p = protocol(t);
  p.target('ordinary', 'page', at('ordinary', ordinary));
  const answer = await attachTimed(p, 'ordinary');
  assert.equal(answer.error, undefined);
  const nav = p.inner().navs.get('ordinary');
  assert.equal(nav.done && !nav.failed, true);
  await pause(NAV_MS + 500);
  assert.equal(nav.unanswered, undefined);
  assert.equal(nav.failed, false);
});

test('setup answered late but before the timer settles ok and is never marked unanswered', {
  timeout: 30000,
}, async (t) => {
  const p = protocol(t);
  p.target('ordinary', 'page', at('ordinary', ordinary));
  p.hold(setup);
  const attaching = attachTimed(p, 'ordinary');
  await whileHeld(p);
  await pause(1000);
  p.hold(() => false);
  p.release(p.held[0]);
  const answer = await attaching;
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  const nav = p.inner().navs.get('ordinary');
  await pause(NAV_MS + 500);
  assert.equal(nav.unanswered, undefined);
  assert.equal(nav.failed, false);
});

test('setup answered after the timer leaves the next nav unmarked, and the tab attaches again', {
  timeout: 40000,
}, async (t) => {
  const p = protocol(t);
  p.target('ordinary', 'page', at('ordinary', ordinary));
  p.hold(setup);
  assert.equal((await attachTimed(p, 'ordinary')).error, UNANSWERED);
  const stale = p.inner().navs.get('ordinary');
  assert.equal(stale.unanswered, true);
  p.hold(() => false);
  p.release(p.held[0]);
  for (let n = 0; n < 50; n += 1) await flush();
  const again = await attachTimed(p, 'ordinary');
  assert.equal(again.error, undefined, JSON.stringify(again));
  const fresh = p.inner().navs.get('ordinary');
  assert.notEqual(fresh, stale);
  assert.equal(fresh.unanswered, undefined);
});

test('a nav whose guard session detaches during setup is refused as unguarded and never marked unanswered', {
  timeout: 30000,
}, async (t) => {
  const p = protocol(t);
  p.target('ordinary', 'page', at('ordinary', ordinary));
  p.hold(setup);
  const attaching = attachTimed(p, 'ordinary');
  await whileHeld(p);
  const nav = p.inner().navs.get('ordinary');
  p.emit({
    method: 'Target.detachedFromTarget',
    params: { sessionId: guardSession(p, 'ordinary'), targetId: 'ordinary' },
  });
  const answer = await attaching;
  assert.equal(answer.error, UNGUARDED);
  assert.ok(answer.ms < NAV_MS / 2, `the refusal took ${answer.ms} ms`);
  await pause(NAV_MS + 500);
  assert.equal(nav.unanswered, undefined);
});

test('a destroyed target settles its nav at once, so its timer never fires', {
  timeout: 30000,
}, async (t) => {
  const p = protocol(t);
  p.target('ordinary', 'page', at('ordinary', ordinary));
  p.hold(setup);
  const attaching = attachTimed(p, 'ordinary');
  await whileHeld(p);
  const nav = p.inner().navs.get('ordinary');
  p.emit({ method: 'Target.targetDestroyed', params: { targetId: 'ordinary' } });
  await flush();
  assert.equal(nav.done, true, 'destroy settled the nav');
  const answer = await attaching;
  assert.notEqual(answer.error, undefined);
  assert.notEqual(answer.error, UNANSWERED);
  assert.ok(answer.ms < NAV_MS / 2, `the refusal took ${answer.ms} ms`);
  await pause(NAV_MS + 500);
  assert.equal(nav.unanswered, undefined);
});

test('a command on a session whose guard session was lost is refused as unguarded, not as not answering', async (t) => {
  const p = protocol(t);
  p.target('ordinary', 'page', at('ordinary', ordinary));
  const attached = await attachTimed(p, 'ordinary');
  assert.equal(attached.error, undefined);
  p.emit({
    method: 'Target.detachedFromTarget',
    params: { sessionId: guardSession(p, 'ordinary'), targetId: 'ordinary' },
  });
  await flush();
  const answer = await p.send(
    'Runtime.evaluate',
    { expression: '1', returnByValue: true },
    attached.sessionId
  );
  assert.equal(answer.error?.message, UNGUARDED);
});

test('a linked tab whose setup was refused for its history is refused as unguarded, not as not answering', {
  timeout: 60000,
}, async (t) => {
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), { kind: 'link', version: '2.0.0' })
  );
  p.target('ordinary', 'page', at('ordinary', ordinary));
  p.hold((message) => message.id >= 2 ** 30 && message.method === 'Network.enable');
  const attaching = attachTimed(p, 'ordinary');
  await whileHeld(p);
  p.hold(() => false);
  p.release(p.held[0], {
    error: {
      code: -32000,
      message: "slicc: refused: the target's history may restore a protected document",
    },
  });
  assert.equal((await attaching).error, UNGUARDED);
});

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>form</title><form method=post><input name=a></form>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const page = `http://ordinary.example.test:${server.address().port}/form`;
const chrome = await launch({
  tools: false,
  args: ['--host-resolver-rules=MAP ordinary.example.test 127.0.0.1'],
});
after(() => chrome.close());
const { browser } = await devtools(chrome);

async function guarded() {
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const wire = { send: (text) => socket.send(text), close: () => socket.close() };
  socket.onmessage = ({ data }) => wire.onmessage?.(String(data));
  const connection = guardProtected(
    wire,
    'https://seven.sliccy.ai',
    new Map(),
    guardRoute('devtools')
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
        resolve({ error: { message: `${method} did not answer within 30000 ms` } });
      }, 30000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, close: () => connection.close() };
}

async function evaluate(targetId, expression) {
  const client = await guarded();
  try {
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
    if (attached.error) return { error: attached.error.message };
    const answer = await client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      attached.result.sessionId
    );
    return answer.error ? { error: answer.error.message } : { value: answer.result.result.value };
  } finally {
    client.close();
  }
}

test('a tab whose page stopped answering behind a dialog is refused as not answering, can be closed, and a fresh tab works', {
  timeout: 120000,
}, async () => {
  const stuck = (await chrome.cdp.send('Target.createTarget', { url: page })).targetId;
  const fresh = (await chrome.cdp.send('Target.createTarget', { url: page })).targetId;
  await pause(1000);
  assert.deepEqual(await evaluate(stuck, 'location.pathname'), { value: '/form' });
  assert.deepEqual(await evaluate(stuck, 'setTimeout(() => alert("held"), 50), 1'), { value: 1 });
  await pause(500);
  assert.deepEqual(await evaluate(stuck, 'location.pathname'), { error: UNANSWERED });
  assert.deepEqual(await evaluate(fresh, 'location.pathname'), { value: '/form' });
  const client = await guarded();
  try {
    const activated = await client.send('Target.activateTarget', { targetId: stuck });
    assert.equal(activated.error, undefined, JSON.stringify(activated));
    const closed = await client.send('Target.closeTarget', { targetId: stuck });
    assert.equal(closed.error, undefined, JSON.stringify(closed));
  } finally {
    client.close();
  }
  await chrome.cdp.send('Target.closeTarget', { targetId: fresh }).catch(() => {});
});
