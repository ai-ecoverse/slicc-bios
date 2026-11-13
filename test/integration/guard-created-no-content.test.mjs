import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { devtools, launch } from './chrome.mjs';

const server = createServer((request, response) => {
  response.writeHead(204);
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const seven = 'https://seven.sliccy.ai';
const destination = `http://ordinary.example.test:${server.address().port}/no-content`;
const chrome = await launch({
  tools: false,
  args: ['--host-resolver-rules=MAP ordinary.example.test 127.0.0.1'],
});
after(() => chrome.close());
const { browser } = await devtools(chrome);

async function guarded(t) {
  const socket = new WebSocket(browser);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const wire = { send: (text) => socket.send(text), close: () => socket.close() };
  socket.onmessage = ({ data }) => wire.onmessage?.(String(data));
  const connection = guardProtected(wire, seven);
  t.after(() => connection.close());
  const pending = new Map();
  let next = 0;
  connection.onmessage = (text) => {
    const message = JSON.parse(text);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  return (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} did not answer within 20000 ms` } });
      }, 20000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
}

test('a guarded createTarget of a 204 URL without an opener stays attachable', {
  timeout: 60000,
}, async (t) => {
  const send = await guarded(t);
  const started = Date.now();
  const created = await send('Target.createTarget', { url: destination });
  const createdAt = Date.now() - started;
  assert.equal(created.error, undefined, JSON.stringify(created));
  const { targetId } = created.result;
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  const attachedAt = Date.now() - started;
  const evaluated = attached.result?.sessionId
    ? await send(
        'Runtime.evaluate',
        {
          expression: '({ url: document.URL, opener: window.opener === null })',
          returnByValue: true,
        },
        attached.result.sessionId
      )
    : null;
  t.diagnostic(
    `FACT 1572 ${JSON.stringify({ createdAt, attachedAt, attached, evaluated: evaluated?.result ?? evaluated?.error })}`
  );
  assert.equal(attached.error, undefined, JSON.stringify(attached));
  assert.ok(attached.result.sessionId);
  assert.ok(createdAt < 2000, `createTarget waited ${createdAt} ms for a commit that never comes`);
});
