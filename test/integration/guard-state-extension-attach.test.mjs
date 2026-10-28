import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  guardProtected,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

const { extensionConnection } = await import(process.env.CDP_SOURCE ?? '../../src/seed/cdp.js');

function adapter(t) {
  const calls = [];
  const messages = [];
  let receive;
  const connection = extensionConnection({
    on(listener) {
      receive = listener;
      return () => {};
    },
    send(method, params) {
      if (method !== 'Target.attachToTarget') return Promise.resolve({});
      return new Promise((resolve, reject) => calls.push({ params, resolve, reject }));
    },
  });
  connection.onmessage = (text) => messages.push(JSON.parse(text));
  t.after(() => connection.close());
  const event = (targetId, sessionId) => ({
    method: 'Target.attachedToTarget',
    params: {
      sessionId,
      targetInfo: { targetId, type: 'page', url: 'https://ordinary.invalid', title: 'ordinary' },
      waitingForDebugger: false,
    },
  });
  return {
    connection,
    calls,
    messages,
    event,
    emit: (message) => receive(message),
    attach: (id, targetId) =>
      connection.send(
        JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId, flatten: true } })
      ),
  };
}

test('state extension retains an early attach event only for the answered target and session', {
  timeout: 5000,
}, async (t) => {
  const wire = adapter(t);
  wire.attach(1, 'ordinary');
  await flush();
  const matching = wire.event('ordinary', 'attached');
  wire.emit(wire.event('unrequested', 'attached'));
  wire.emit(wire.event('ordinary', 'other-session'));
  wire.emit(matching);
  assert.deepEqual(wire.messages, []);
  wire.calls[0].resolve({ sessionId: 'attached' });
  await flush();
  assert.deepEqual(wire.messages, [matching, { id: 1, result: { sessionId: 'attached' } }]);
  wire.emit(wire.event('unrequested', 'unsolicited'));
  assert.equal(wire.messages.length, 2);
});

for (const result of ['failed', 'no session', 'closed']) {
  test(`state extension discards an early attach event when the attachment is ${result}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = adapter(t);
    wire.attach(1, 'ordinary');
    await flush();
    wire.emit(wire.event('ordinary', 'attached'));
    if (result === 'closed') wire.connection.close();
    if (result === 'failed') wire.calls[0].reject(new Error('synthetic attachment refusal'));
    else wire.calls[0].resolve(result === 'closed' ? { sessionId: 'attached' } : {});
    await flush();
    assert.equal(
      wire.messages.some(({ method }) => method === 'Target.attachedToTarget'),
      false
    );
    if (result === 'failed')
      assert.equal(wire.messages[0].error.message, 'synthetic attachment refusal');
    if (result === 'no session') assert.deepEqual(wire.messages, [{ id: 1, result: {} }]);
    if (result === 'closed') assert.deepEqual(wire.messages, []);
    wire.emit(wire.event('ordinary', 'later-unrequested'));
    assert.equal(
      wire.messages.some(({ method }) => method === 'Target.attachedToTarget'),
      false
    );
  });
}

test('state extension matches reversed early attach events to separate pending requests', {
  timeout: 5000,
}, async (t) => {
  const wire = adapter(t);
  wire.attach(1, 'ordinary');
  wire.attach(2, 'ordinary');
  await flush();
  const first = wire.event('ordinary', 'first');
  const second = wire.event('ordinary', 'second');
  wire.emit(second);
  wire.emit(first);
  wire.calls[1].resolve({ sessionId: 'second' });
  await flush();
  wire.calls[0].resolve({ sessionId: 'first' });
  await flush();
  assert.deepEqual(wire.messages, [
    second,
    { id: 2, result: { sessionId: 'second' } },
    first,
    { id: 1, result: { sessionId: 'first' } },
  ]);
});

function extensionGuard(raw, origin) {
  const pending = new Map();
  const listeners = new Set();
  let next = 0;
  raw.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.method) {
      for (const listener of listeners) listener(message);
      return;
    }
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  };
  return guardProtected(
    extensionConnection({
      send(method, params, sessionId) {
        const id = ++next;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          raw.send(JSON.stringify({ id, method, params, sessionId }));
        });
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    origin
  );
}

test('state extension early attach to a protected error root reaches the client as origin-only metadata', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t, extensionGuard);
  const entry = wire.target('extension-error');
  await wire.attach('extension-error');
  entry.tree.frame = errorFrame('extension-error');
  entry.info.url = failed;
  entry.info.title = `${failed}?private-query#private-fragment`;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'client-extension-error',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  const mark = wire.delivered.length;
  wire.hold((message) => {
    if (message.method !== 'Target.attachToTarget') return false;
    queueMicrotask(() => {
      wire.attached('extension-error', undefined, 'client-extension-error-new');
      wire.release(message, { result: { sessionId: 'client-extension-error-new' } });
    });
    return true;
  });
  const answer = await wire.send('Target.attachToTarget', {
    targetId: 'extension-error',
    flatten: true,
  });
  assert.equal(answer.error, undefined);
  await flush();
  const attached = wire.delivered
    .slice(mark)
    .find(({ method }) => method === 'Target.attachedToTarget');
  assert.ok(attached);
  assert.equal(attached.params.sessionId, answer.result.sessionId);
  assert.equal(attached.params.targetInfo.url, protectedOrigin);
  assert.equal(attached.params.targetInfo.title, protectedOrigin);
  assert.equal(JSON.stringify(wire.delivered.slice(mark)).includes('private-'), false);
});
