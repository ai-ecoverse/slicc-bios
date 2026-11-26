import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { guardProtected, UNANSWERED } from '../../src/seed/guard.js';
import { devtools, launch } from './chrome.mjs';
import { guardRoute } from './guard-route.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let served = 0;
const server = createServer((_request, response) => {
  served += 1;
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end(`<!doctype html><title>form</title><p id="mark">document-${served}</p>`);
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

async function evaluate(client, targetId, expression) {
  const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
  if (attached.error) return { error: attached.error.message };
  const answer = await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    attached.result.sessionId
  );
  return answer.error ? { error: answer.error.message } : { value: answer.result.result.value };
}

async function once(targetId, expression) {
  const client = await guarded();
  try {
    return await evaluate(client, targetId, expression);
  } finally {
    client.close();
  }
}

test('a tab that stopped answering behind a dialog is reloaded through the guard into a fresh document, drivable on the same connection', {
  timeout: 180000,
}, async (t) => {
  const stuck = (await chrome.cdp.send('Target.createTarget', { url: page })).targetId;
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId: stuck }).catch(() => {}));
  await pause(1000);
  const mark = 'document.getElementById("mark").textContent';
  const first = await once(stuck, mark);
  assert.match(first.value ?? '', /^document-\d+$/, JSON.stringify(first));
  assert.deepEqual(await once(stuck, 'setTimeout(() => alert("held"), 50), 1'), { value: 1 });
  await pause(500);
  const client = await guarded();
  t.after(() => client.close());
  const refused = await client.send('Target.attachToTarget', { targetId: stuck, flatten: true });
  assert.equal(refused.error?.message, UNANSWERED, JSON.stringify(refused));
  const reloaded = await client.send('Page.reload', { targetId: stuck });
  assert.equal(reloaded.error, undefined, JSON.stringify(reloaded));
  const deadline = Date.now() + 60000;
  let read;
  while (Date.now() < deadline) {
    read = await evaluate(client, stuck, mark);
    if (read.value !== undefined) break;
    await pause(500);
  }
  assert.match(read.value ?? '', /^document-\d+$/, JSON.stringify(read));
  assert.notEqual(read.value, first.value, 'the tab holds a fresh document');
});
