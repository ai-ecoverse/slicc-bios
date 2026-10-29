import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { ordinary, plainFrame, protectedOrigin } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

function createdProtocol(t, transport, securityOrigin, destination = ordinary) {
  const id = 'created-navigation';
  const listeners = new Set();
  const waiting = new Map();
  const delivered = [];
  let nextSession = 0;
  let next = 0;
  let timer;
  let finish;
  let begin;
  const navigating = new Promise((resolve) => {
    begin = resolve;
  });
  const committed = new Promise((resolve) => {
    finish = resolve;
  });
  let frame = { id, url: 'about:blank', securityOrigin: '://', loaderId: 'blank-document' };
  let url = frame.url;
  const cdp = {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params = {}, sessionId) {
      if (method === 'Target.createTarget') return { targetId: id };
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: id, type: 'page', url } };
      if (method === 'Target.attachToTarget') {
        return { sessionId: `session-${++nextSession}` };
      }
      if (method === 'Page.navigate') {
        url = ordinary;
        frame = { id, url: '', securityOrigin };
        begin();
        if (destination === 'unanswered') return new Promise(() => {});
        if (destination === 'rejected') throw new Error('synthetic navigation failure');
        return new Promise((resolve) => {
          timer = setTimeout(() => {
            frame = {
              ...plainFrame(id),
              url: destination,
              securityOrigin: new URL(destination).origin,
              loaderId: 'ordinary-document',
            };
            url = destination;
            for (const listener of listeners)
              listener({ method: 'Page.frameNavigated', sessionId, params: { frame } });
            resolve({ frameId: id, loaderId: frame.loaderId });
            finish();
          }, 1200);
        });
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame } };
      if (method === 'Page.getNavigationHistory')
        return { currentIndex: 0, entries: [{ id: 1, url, title: 'ordinary' }] };
      if (method === 'DOM.getDocument')
        return { root: { nodeId: 1, nodeName: '#document', children: [] } };
      if (method === 'Runtime.evaluate')
        return {
          result: { value: params.expression === 'location.href' ? url : 'synthetic-content' },
        };
      return {};
    },
  };
  const raw = {
    send(text) {
      const { id, method, params, sessionId } = JSON.parse(text);
      const deliver = (answer) =>
        raw.onmessage(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), ...answer }));
      void cdp.send(method, params, sessionId).then(
        (result) => deliver({ result }),
        (error) => deliver({ error: { code: -32000, message: error.message } })
      );
    },
    close() {},
  };
  const off = cdp.on((message) => raw.onmessage?.(JSON.stringify(message)));
  const guard = guardProtected(
    transport === 'extension' ? extensionConnection(cdp) : raw,
    protectedOrigin
  );
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  t.after(() => {
    clearTimeout(timer);
    guard.close();
    off();
  });
  return {
    committed,
    navigating,
    delivered,
    close: () => guard.close(),
    listen(callback) {
      guard.onmessage = callback;
    },
    send(method, params = {}, sessionId) {
      const id = ++next;
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return answer;
    },
  };
}

for (const transport of ['direct', 'extension']) {
  test(`a closed guard does not publish a delayed created tab over ${transport}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wire = createdProtocol(t, transport, '');
    void wire.send('Target.createTarget', { url: ordinary });
    await wire.navigating;
    wire.close();
    const late = [];
    wire.listen((text) => late.push(JSON.parse(text)));
    t.mock.timers.tick(10000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(late, [], 'closing suppresses every delayed create response');
  });

  for (const securityOrigin of ['', '://']) {
    test(`an ordinary created tab waits for its navigation answer with initial origin ${JSON.stringify(securityOrigin)} over ${transport}`, {
      timeout: 5000,
    }, async (t) => {
      const wire = createdProtocol(t, transport, securityOrigin);
      const created = await wire.send('Target.createTarget', { url: ordinary });
      assert.equal(created.error, undefined);
      const attached = await wire.send('Target.attachToTarget', {
        targetId: created.result.targetId,
        flatten: true,
      });
      assert.equal(
        attached.error,
        undefined,
        'the ordinary attachment is admitted on its first call'
      );
      await wire.committed;
      const content = await wire.send(
        'Runtime.evaluate',
        { expression: 'document.title' },
        attached.result.sessionId
      );
      assert.equal(content.error, undefined);
      assert.equal(content.result.result.value, 'synthetic-content');
    });
  }

  test(`a created tab is still published when its navigation never answers over ${transport}`, {
    timeout: 15000,
  }, async (t) => {
    const wire = createdProtocol(t, transport, '', 'unanswered');
    const started = Date.now();
    const created = await wire.send('Target.createTarget', { url: ordinary });
    assert.equal(created.error, undefined);
    assert.equal(created.result.targetId, 'created-navigation');
    assert.ok(Date.now() - started < 12000, 'the existing navigation deadline bounds creation');
    const attached = await wire.send('Target.attachToTarget', {
      targetId: created.result.targetId,
      flatten: true,
    });
    assert.match(attached.error?.message ?? '', /^slicc: refused:/);
    assert.equal(attached.result, undefined);
  });

  test(`a created tab is still published when its navigation answers with an error over ${transport}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = createdProtocol(t, transport, '', 'rejected');
    const created = await wire.send('Target.createTarget', { url: ordinary });
    assert.equal(created.error, undefined);
    assert.equal(created.result.targetId, 'created-navigation');
    const attached = await wire.send('Target.attachToTarget', {
      targetId: created.result.targetId,
      flatten: true,
    });
    assert.match(attached.error?.message ?? '', /^slicc: refused:/);
    assert.equal(attached.result, undefined);
  });

  test(`a protected document committed by a created tab remains refused over ${transport}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = createdProtocol(t, transport, '', `${protectedOrigin}/private`);
    const created = await wire.send('Target.createTarget', { url: ordinary });
    assert.equal(created.error, undefined);
    await wire.committed;
    const attached = await wire.send('Target.attachToTarget', {
      targetId: created.result.targetId,
      flatten: true,
    });
    assert.match(attached.error?.message ?? '', /^slicc: refused:/);
    assert.equal(attached.result, undefined);
    assert.equal(
      wire.delivered.some((message) => message.result?.result?.value === 'synthetic-content'),
      false
    );
  });
}
