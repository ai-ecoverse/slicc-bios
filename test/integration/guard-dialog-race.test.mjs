import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import * as guard from '../../src/seed/guard.js';
import { devtools, launch } from './chrome.mjs';

const OWN = 'https://seven.sliccy.ai';
const ANSWER_MS = 20000;
const SETTLE_MS = 1500;
const BARRIER_MS = 3000;
const NO_DIALOG = /No dialog is showing/;
const loads = new Map();

const site = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const [, kind, key] = url.pathname.split('/');
  const counted = `${kind}/${key}`;
  loads.set(counted, (loads.get(counted) ?? 0) + 1);
  const said = `${loads.get(counted) === 1 ? 'one' : 'two'} ${key}`;
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end(
    kind === 'dialog'
      ? `<!doctype html><title>${said}</title><script>setTimeout(() => alert(${JSON.stringify(said)}), 100);</script>`
      : kind === 'leave'
        ? "<!doctype html><title>leave</title><script>onbeforeunload = (event) => { event.preventDefault(); event.returnValue = 'x'; };</script><p style='height:100vh'>leave</p>"
        : '<!doctype html><title>plain</title><p>plain</p>'
  );
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
after(() => site.close());
const port = site.address().port;
const ordinary = (kind, key) => `http://ordinary.test:${port}/${kind}/${key}`;

const chrome = await launch({
  tools: false,
  vault: false,
  args: ['--host-resolver-rules=MAP ordinary.test 127.0.0.1'],
});
after(() => chrome.close());
const { browser } = await devtools(chrome);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function client(t, guarded) {
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const watchers = new Set();
  let barrier;
  let inner;
  const wire = {
    send(text) {
      const { method } = JSON.parse(text);
      for (const watcher of watchers) watcher(method);
      if (barrier?.method !== method) return socket.send(text);
      const { until } = barrier;
      barrier.capture();
      barrier = undefined;
      void Promise.race([until.then(() => 'dialog'), pause(BARRIER_MS).then(() => 'timeout')]).then(
        (why) => {
          wire.released = why;
          socket.send(text);
        }
      );
    },
    close: () => socket.close(),
    captureGuard(instance) {
      inner = instance;
    },
  };
  socket.onmessage = ({ data }) => wire.onmessage?.(String(data));
  socket.onclose = () => wire.onclose?.('closed');
  const connection = guarded ? guard.guardProtected(wire, OWN) : wire;
  t.after(() => connection.close());
  const pending = new Map();
  const events = [];
  const waiters = new Set();
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    events.push(message);
    for (const waiter of waiters) waiter(message);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} did not answer within ${ANSWER_MS} ms` } });
      }, ANSWER_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const event = (method, match = () => true) => {
    const found = events.find((message) => message.method === method && match(message));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`no ${method} within ${ANSWER_MS} ms`));
      }, ANSWER_MS);
      const waiter = (message) => {
        if (message.method !== method || !match(message)) return;
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(message);
      };
      waiters.add(waiter);
    });
  };
  const sent = (method) =>
    new Promise((resolve) => {
      const watcher = (seen) => {
        if (seen !== method) return;
        watchers.delete(watcher);
        resolve();
      };
      watchers.add(watcher);
    });
  const holdNext = (method, until) =>
    new Promise((capture) => {
      barrier = { method, until, capture };
    });
  const attach = async (targetId, page = true) => {
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    assert.ok(attached.result?.sessionId, JSON.stringify(attached));
    const sessionId = attached.result.sessionId;
    if (!page) return sessionId;
    const enabled = await send('Page.enable', {}, sessionId);
    assert.equal(enabled.error, undefined, JSON.stringify(enabled));
    return sessionId;
  };
  const unhold = () => {
    barrier = undefined;
  };
  return { send, events, event, attach, sent, holdNext, unhold, wire, inner: () => inner };
}

async function tab(t, key) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', {
    url: ordinary('plain', key),
  });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  return targetId;
}

const saying = (said) => (message) => message.params?.message === said;

async function firstDialog(a, sa, key) {
  const opened = a.event('Page.javascriptDialogOpening', saying(`one ${key}`));
  const went = await a.send('Page.navigate', { url: ordinary('dialog', key) }, sa);
  assert.equal(went.error, undefined, JSON.stringify(went));
  return opened;
}

function answeredFirst(answer) {
  if (!answer.error) return;
  assert.ok(
    [guard.DIALOG_GONE, guard.DIALOG_UNSEEN, guard.PROTECTED].includes(answer.error.message) ||
      NO_DIALOG.test(answer.error.message),
    JSON.stringify(answer)
  );
}

async function secondStaysOpen(a, sa, key) {
  const second = await a.event('Page.javascriptDialogOpening', saying(`two ${key}`));
  await pause(SETTLE_MS);
  const after = a.events.slice(a.events.indexOf(second) + 1);
  assert.deepEqual(
    after.filter((message) => message.method === 'Page.javascriptDialogClosed'),
    [],
    `an answer meant for the first dialog closed the second (the held answer was released by ${a.wire.released ?? 'nothing'})`
  );
  const at = a.events.indexOf(second);
  const closed = a.event(
    'Page.javascriptDialogClosed',
    (message) => a.events.indexOf(message) > at
  );
  const answered = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
  assert.equal(answered.error, undefined, JSON.stringify(answered));
  await closed;
}

async function race(t, key, guarded, answerFirst) {
  const targetId = await tab(t, key);
  const a = await client(t, true);
  const mover = await client(t, guarded);
  const watcher = await client(t, false);
  const sa = await a.attach(targetId);
  const sm = await mover.attach(targetId);
  await watcher.attach(targetId);
  await firstDialog(a, sa, key);
  const second = watcher.event('Page.javascriptDialogOpening', saying(`two ${key}`));
  const captured = a.holdNext('Page.handleJavaScriptDialog', second);
  let answering;
  if (answerFirst) {
    answering = a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
    await captured;
  }
  const reloaded = mover.sent('Page.reload');
  const reloading = mover.send('Page.reload', {}, sm);
  await reloaded;
  answering ??= a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
  const answer = await answering;
  a.unhold();
  const reload = await reloading;
  assert.equal(reload.error, undefined, JSON.stringify(reload));
  answeredFirst(answer);
  await secondStaysOpen(a, sa, key);
}

for (const [guarded, who] of [
  [true, 'another guarded client'],
  [false, 'a client outside the guard'],
])
  for (const answerFirst of [true, false])
    test(
      `an answer to the first dialog that reaches Chrome late never lands on the dialog a reload by ${who} opens (${answerFirst ? 'answer sent first' : 'reload sent first'})`,
      {
        timeout: 120000,
      },
      (t) =>
        race(
          t,
          `${guarded ? 'guarded' : 'outside'}-${answerFirst ? 'answer' : 'reload'}`,
          guarded,
          answerFirst
        )
    );

async function untilDialogRecord(inner, targetId, ms = ANSWER_MS) {
  const dialog = () => inner.navs.get(targetId)?.dialog;
  for (const end = Date.now() + ms; Date.now() < end; await pause(5)) {
    if (dialog()?.record) return dialog();
  }
  assert.fail(
    `guard.navs.get(${JSON.stringify(targetId)}).dialog.record was missing within ${ms} ms; dialog=${JSON.stringify(dialog())}`
  );
}

test('a client that never enabled Page still answers the open dialog, and after it closes none is', {
  timeout: 120000,
}, async (t) => {
  const key = 'blind';
  const targetId = await tab(t, key);
  const a = await client(t, true);
  const sa = await a.attach(targetId, false);
  const watcher = await client(t, false);
  const sw = await watcher.attach(targetId);
  await firstDialog(watcher, sw, key);
  const closed = watcher.event('Page.javascriptDialogClosed');
  await untilDialogRecord(a.inner(), targetId);
  const answered = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
  assert.equal(answered.error, undefined, JSON.stringify(answered));
  await closed;
  const again = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
  assert.equal(again.error?.message, guard.DIALOG_UNSEEN, JSON.stringify(again));
});

test('after the user stays on a page its beforeunload prompt asked about, the page’s next dialog is answered', {
  timeout: 120000,
}, async (t) => {
  const key = 'stay';
  const targetId = await tab(t, key);
  const a = await client(t, true);
  const sa = await a.attach(targetId);
  const watcher = await client(t, false);
  const sw = await watcher.attach(targetId);
  const went = await a.send('Page.navigate', { url: ordinary('leave', key) }, sa);
  assert.equal(went.error, undefined, JSON.stringify(went));
  let ready;
  for (const end = Date.now() + 10000; Date.now() < end && ready !== 'complete'; await pause(50))
    ready = (
      await watcher.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        sw
      )
    ).result?.result?.value;
  assert.equal(ready, 'complete');
  for (const type of ['mousePressed', 'mouseReleased'])
    await watcher.send(
      'Input.dispatchMouseEvent',
      { type, x: 20, y: 20, button: 'left', clickCount: 1 },
      sw
    );
  const leaving = a.event(
    'Page.javascriptDialogOpening',
    (message) => message.params?.type === 'beforeunload'
  );
  const moving = watcher.send(
    'Runtime.evaluate',
    { expression: `location.href = ${JSON.stringify(ordinary('plain', key))}` },
    sw
  );
  await leaving;
  const stayed = await a.send('Page.handleJavaScriptDialog', { accept: false }, sa);
  assert.equal(stayed.error, undefined, JSON.stringify(stayed));
  await moving;
  const later = a.event('Page.javascriptDialogOpening', saying('later'));
  await watcher.send(
    'Runtime.evaluate',
    { expression: "setTimeout(() => alert('later'), 50)" },
    sw
  );
  await later;
  const answered = await a.send('Page.handleJavaScriptDialog', { accept: true }, sa);
  assert.equal(answered.error, undefined, JSON.stringify(answered));
});
