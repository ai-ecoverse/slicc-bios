import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { guardProtected, UNANSWERED, UNGUARDED } from '../../src/seed/guard.js';
import { devtools, launch } from './chrome.mjs';
import { flush, protocol } from './guard-ordering-fixture.mjs';

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
  const connection = guardProtected(wire, 'https://seven.sliccy.ai');
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
