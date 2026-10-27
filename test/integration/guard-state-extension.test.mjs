import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';

const { extensionConnection } = await import(process.env.CDP_SOURCE ?? '../../src/seed/cdp.js');
const ordinary = 'https://extension-ordinary.invalid/page';

function extensionProtocol(t) {
  const attached = new Map();
  const held = [];
  const delivered = [];
  const waiting = new Map();
  let serial = 0;
  let next = 0;
  let holding = () => false;
  const cdp = {
    on() {
      return () => {};
    },
    async send(method, params = {}, sessionId) {
      const targetId = params.targetId ?? attached.get(sessionId);
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId, type: 'page', url: ordinary } };
      if (method === 'Target.attachToTarget') {
        const created = `extension-session-${++serial}`;
        attached.set(created, targetId);
        return { sessionId: created };
      }
      if (method === 'Page.getFrameTree')
        return {
          frameTree: {
            frame: { id: targetId, url: ordinary, securityOrigin: new URL(ordinary).origin },
          },
        };
      if (method === 'Page.getNavigationHistory')
        return { currentIndex: 0, entries: [{ id: 1, url: ordinary, title: 'ordinary' }] };
      if (holding(method, params, sessionId))
        return new Promise((resolve) => held.push({ sessionId, resolve }));
      if (method === 'Page.reload') throw new Error('synthetic-extension-error');
      if (method === 'Runtime.evaluate')
        return { result: { type: 'string', value: `ordinary-content-${targetId}` } };
      return {};
    },
  };
  const guard = guardProtected(extensionConnection(cdp), 'https://extension-protected.invalid');
  const key = (id, sessionId) => JSON.stringify([sessionId ?? null, id]);
  guard.onmessage = (text) => {
    const reply = JSON.parse(text);
    delivered.push(reply);
    waiting.get(key(reply.id, reply.sessionId))?.(reply);
  };
  t.after(() => guard.close());
  function request(method, params = {}, sessionId, id = ++next) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(key(id, sessionId));
        reject(new Error(`${method} has no matching protocol reply`));
      }, 1000);
      waiting.set(key(id, sessionId), (reply) => {
        clearTimeout(timer);
        waiting.delete(key(id, sessionId));
        resolve(reply);
      });
      guard.send(
        JSON.stringify({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) })
      );
    });
  }
  return {
    request,
    delivered,
    held,
    hold(fn) {
      holding = fn;
    },
    async attach(targetId) {
      const reply = await request('Target.attachToTarget', { targetId, flatten: true });
      assert.equal(reply.error, undefined);
      return reply.result.sessionId;
    },
  };
}

test('state extension adapter delivers ordinary session replies through the guard', async (t) => {
  const wire = extensionProtocol(t);
  const sessionId = await wire.attach('extension-live');
  for (const method of ['Page.enable', 'Runtime.evaluate']) {
    const reply = await wire.request(method, {}, sessionId);
    assert.equal(reply.error, undefined);
    assert.equal(reply.sessionId, sessionId);
    assert.ok(reply.result);
  }
  assert.equal(wire.delivered.filter((reply) => reply.sessionId === sessionId).length, 2);
});

test('state extension adapter preserves scoped errors and subsequent replies', async (t) => {
  const wire = extensionProtocol(t);
  const sessionId = await wire.attach('extension-error');
  const error = await wire.request('Page.reload', {}, sessionId);
  assert.equal(error.sessionId, sessionId);
  assert.deepEqual(error.error, { code: -32000, message: 'synthetic-extension-error' });
  const reply = await wire.request('Page.enable', {}, sessionId);
  assert.equal(reply.sessionId, sessionId);
  assert.deepEqual(reply.result, {});
});

test('state extension adapter keeps equal caller IDs owned across reversed session replies', async (t) => {
  const wire = extensionProtocol(t);
  const first = await wire.attach('extension-first');
  const second = await wire.attach('extension-second');
  wire.hold((method) => method === 'Runtime.evaluate');
  const a = wire.request('Runtime.evaluate', {}, first, 77);
  const b = wire.request('Runtime.evaluate', {}, second, 77);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wire.held.length, 2);
  wire.held
    .find((reply) => reply.sessionId === second)
    .resolve({ result: { type: 'string', value: 'ordinary-second' } });
  wire.held
    .find((reply) => reply.sessionId === first)
    .resolve({ result: { type: 'string', value: 'ordinary-first' } });
  const [aReply, bReply] = await Promise.all([a, b]);
  assert.equal(aReply.sessionId, first);
  assert.equal(aReply.result.result.value, 'ordinary-first');
  assert.equal(bReply.sessionId, second);
  assert.equal(bReply.result.result.value, 'ordinary-second');
  assert.equal(wire.delivered.filter((reply) => reply.id === 77).length, 2);
});

for (const valid of [false, true]) {
  test(`state extension adapter keeps the session on direct protocol replies ${valid}`, async (t) => {
    const connection = extensionConnection({
      on: () => () => {},
      send: async () => ({ live: true }),
    });
    const delivered = [];
    connection.onmessage = (text) => delivered.push(JSON.parse(text));
    t.after(() => connection.close());
    connection.send(
      JSON.stringify({
        id: 9,
        sessionId: 'direct-session',
        ...(valid ? { method: 'Page.enable' } : {}),
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].sessionId, 'direct-session');
    assert.equal(delivered[0].id, 9);
    if (valid) assert.deepEqual(delivered[0].result, { live: true });
    else assert.equal(delivered[0].error.code, -32600);
  });
}

test('state extension adapter keeps root protocol replies unscoped', async (t) => {
  const connection = extensionConnection({
    on: () => () => {},
    send: async () => ({ live: true }),
  });
  const delivered = [];
  connection.onmessage = (text) => delivered.push(JSON.parse(text));
  t.after(() => connection.close());
  connection.send(JSON.stringify({ id: 10, method: 'Page.enable' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [{ id: 10, result: { live: true } }]);
});
