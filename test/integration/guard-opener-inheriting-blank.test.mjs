import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { ordinary, protectedOrigin } from './guard-ordering-fixture.mjs';

const { guardProtected, PROTECTED } = await import(
  process.env.GUARD_SOURCE ?? '../../src/seed/guard.js'
);

const routes = [
  { name: 'devtools', route: { kind: 'devtools' }, connection: 'direct' },
  { name: 'link', route: { kind: 'link', version: '1.60.0' }, connection: 'direct' },
  { name: 'extension', route: { kind: 'extension', version: '7.12.0' }, connection: 'extension' },
];
const seven = `${protectedOrigin}/seven`;
const ordinaryOpener = `${new URL(ordinary).origin}/opener`;
const READ = 'opener.location.href';
const blank = (id, loaderId) => ({ id, url: 'about:blank', securityOrigin: '://', loaderId });

const committed = (id, url) => ({
  id,
  url,
  securityOrigin: new URL(url).origin,
  loaderId: 'committed-document',
});
const unusable = {
  error: () => {
    throw new Error('synthetic opener read failure');
  },
  'wrong target': (opener) => ({ targetInfo: { ...opener, targetId: 'another-target' } }),
  'no URL': ({ url, ...rest }) => ({ targetInfo: rest }),
  'a disagreeing event': (opener, emit) => {
    emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { ...opener, url: 'https://other.invalid/moved' } },
    });
    return { targetInfo: { ...opener } };
  },
};

function openerWire(
  t,
  { route, connection },
  { openerUrl, reported, commit, popup = false, settled = false }
) {
  const id = `inheriting-blank-${Math.random().toString(36).slice(2, 8)}`;
  const opener = { targetId: `${id}-opener`, type: 'page', url: openerUrl };
  const related = { openerId: opener.targetId, canAccessOpener: true };
  const listeners = new Set();
  const waiting = new Map();
  const delivered = [];
  const forwarded = [];
  let nextSession = 0;
  let next = 0;
  let timer;
  let info = {
    targetId: id,
    type: 'page',
    url: popup ? reported : 'about:blank',
    ...(popup ? related : {}),
  };
  let frame = settled ? committed(id, reported) : blank(id, 'blank-document');
  let broken;
  const cdp = {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params = {}, sessionId) {
      if (method === 'Target.createTarget') return { targetId: id };
      if (method === 'Target.getTargetInfo') {
        if (params.targetId === opener.targetId)
          return broken
            ? unusable[broken](opener, (message) => {
                for (const listener of listeners) listener(message);
              })
            : { targetInfo: { ...opener } };
        return { targetInfo: { ...info } };
      }
      if (method === 'Target.attachToTarget') return { sessionId: `session-${++nextSession}` };
      if (method === 'Page.navigate') {
        return new Promise((resolve) => {
          timer = setTimeout(() => {
            info = { targetId: id, type: 'page', url: reported, ...related };
            frame = blank(id, 'navigating');
            resolve({ frameId: id, loaderId: 'navigating' });
            if (!commit) return;
            setTimeout(() => {
              info = { targetId: id, type: 'page', url: commit, ...related };
              frame = committed(id, commit);
              for (const listener of listeners)
                listener({ method: 'Page.frameNavigated', sessionId, params: { frame } });
            }, 50);
          }, 20);
        });
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame } };
      if (method === 'Page.getNavigationHistory')
        return { currentIndex: 0, entries: [{ id: 1, url: info.url, title: 'blank' }] };
      if (method === 'DOM.getDocument')
        return { root: { nodeId: 1, nodeName: '#document', children: [] } };
      if (method === 'Runtime.evaluate') {
        if (params.expression === READ) {
          forwarded.push(params.expression);
          const open = info.canAccessOpener === true && frame.url.startsWith('about:');
          return { result: { value: open ? `${opener.url}#session-secret` : null } };
        }
        return {
          result: { value: params.expression === 'location.href' ? frame.url : 'synthetic' },
        };
      }
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
    connection === 'extension' ? extensionConnection(cdp) : raw,
    protectedOrigin,
    new Map(),
    route
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
    id,
    delivered,
    forwarded,
    moveOpener(url) {
      opener.url = url;
    },
    breakOpener(kind) {
      broken = kind;
    },
    reblank() {
      info = { targetId: id, type: 'page', url: 'about:blank', ...related };
      frame = blank(id, 'reblank-document');
    },
    send(method, params = {}, sessionId) {
      const id = ++next;
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return answer;
    },
  };
}

const leaked = (wire) =>
  wire.delivered.some((message) => JSON.stringify(message).includes('session-secret'));

async function readOpener(wire, sessionId) {
  if (!sessionId) {
    const attached = await wire.send('Target.attachToTarget', { targetId: wire.id, flatten: true });
    if (attached.error) return attached;
    sessionId = attached.result.sessionId;
  }
  return wire.send('Runtime.evaluate', { expression: READ }, sessionId);
}

for (const entry of routes) {
  test(`an inheriting blank whose info URL already left about:blank cannot read a protected opener over ${entry.name}`, {
    timeout: 8000,
  }, async (t) => {
    const wire = openerWire(t, entry, { openerUrl: seven, reported: ordinary });
    const created = await wire.send('Target.createTarget', { url: ordinary });
    assert.equal(created.error, undefined);
    const answer = await readOpener(wire);
    assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
    assert.equal(answer.result, undefined);
    assert.deepEqual(wire.forwarded, [], 'the opener read reached the browser');
    assert.equal(leaked(wire), false);
  });

  test(`a window.open popup whose info URL already left about:blank cannot read a protected opener over ${entry.name}`, {
    timeout: 8000,
  }, async (t) => {
    const wire = openerWire(t, entry, { openerUrl: seven, reported: ordinary, popup: true });
    const answer = await readOpener(wire);
    assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
    assert.equal(answer.result, undefined);
    assert.deepEqual(wire.forwarded, [], 'the opener read reached the browser');
    assert.equal(leaked(wire), false);
  });

  test(`a window.open popup still on its inheriting blank refuses its frame tree and history over ${entry.name}`, {
    timeout: 8000,
  }, async (t) => {
    const wire = openerWire(t, entry, { openerUrl: seven, reported: ordinary, popup: true });
    const attached = await wire.send('Target.attachToTarget', { targetId: wire.id, flatten: true });
    assert.equal(attached.error, undefined, JSON.stringify(attached));
    for (const method of ['Page.getFrameTree', 'Page.getNavigationHistory']) {
      const answer = await wire.send(method, {}, attached.result.sessionId);
      assert.equal(answer.error?.message, PROTECTED, `${method}: ${JSON.stringify(answer)}`);
      assert.equal(answer.result, undefined);
    }
    const answer = await readOpener(wire, attached.result.sessionId);
    assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
    assert.deepEqual(wire.forwarded, [], 'the opener read reached the browser');
    assert.equal(leaked(wire), false);
  });

  for (const fresh of [false, true]) {
    test(`an inheriting blank re-reads an opener that became protected without an event before ${fresh ? 'a fresh attach' : 'an evaluate'} over ${entry.name}`, {
      timeout: 8000,
    }, async (t) => {
      const wire = openerWire(t, entry, {
        openerUrl: ordinaryOpener,
        reported: 'about:blank',
        commit: ordinary,
      });
      const created = await wire.send('Target.createTarget', { url: ordinary });
      assert.equal(created.error, undefined);
      const attached = await wire.send('Target.attachToTarget', {
        targetId: wire.id,
        flatten: true,
      });
      assert.equal(attached.error, undefined, JSON.stringify(attached));
      const before = await wire.send(
        'Runtime.evaluate',
        { expression: 'document.title' },
        attached.result.sessionId
      );
      assert.equal(before.error, undefined, JSON.stringify(before));
      wire.moveOpener(seven);
      wire.reblank();
      const answer = await readOpener(wire, fresh ? undefined : attached.result.sessionId);
      assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
      assert.equal(answer.result, undefined);
      assert.deepEqual(wire.forwarded, [], 'the opener read reached the browser');
      assert.equal(leaked(wire), false);
    });
  }

  test(`an inheriting blank whose opener stays ordinary still reads it over ${entry.name}`, {
    timeout: 8000,
  }, async (t) => {
    const wire = openerWire(t, entry, {
      openerUrl: ordinaryOpener,
      reported: 'about:blank',
      commit: ordinary,
    });
    const created = await wire.send('Target.createTarget', { url: ordinary });
    assert.equal(created.error, undefined);
    const attached = await wire.send('Target.attachToTarget', { targetId: wire.id, flatten: true });
    assert.equal(attached.error, undefined, JSON.stringify(attached));
    wire.reblank();
    const answer = await readOpener(wire, attached.result.sessionId);
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    assert.equal(answer.result.result.value, `${ordinaryOpener}#session-secret`);
  });

  for (const kind of Object.keys(unusable)) {
    test(`an inheriting blank stays refused when the fresh opener read answers ${kind} over ${entry.name}`, {
      timeout: 8000,
    }, async (t) => {
      const wire = openerWire(t, entry, {
        openerUrl: ordinaryOpener,
        reported: 'about:blank',
        commit: ordinary,
      });
      const created = await wire.send('Target.createTarget', { url: ordinary });
      assert.equal(created.error, undefined);
      const attached = await wire.send('Target.attachToTarget', {
        targetId: wire.id,
        flatten: true,
      });
      assert.equal(attached.error, undefined, JSON.stringify(attached));
      wire.breakOpener(kind);
      wire.reblank();
      const answer = await readOpener(wire, attached.result.sessionId);
      assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
      assert.equal(answer.result, undefined);
      assert.deepEqual(wire.forwarded, [], 'the opener read reached the browser');
      assert.equal(leaked(wire), false);
    });

    test(`a window.open popup still on its inheriting blank stays refused when its opener read answers ${kind} over ${entry.name}`, {
      timeout: 8000,
    }, async (t) => {
      const wire = openerWire(t, entry, { openerUrl: seven, reported: ordinary, popup: true });
      wire.breakOpener(kind);
      const answer = await readOpener(wire);
      assert.equal(answer.error?.message, PROTECTED, JSON.stringify(answer));
      assert.equal(answer.result, undefined);
      assert.deepEqual(wire.forwarded, [], 'the opener read reached the browser');
      assert.equal(leaked(wire), false);
    });
  }

  test(`a window.open popup of a protected opener that committed an ordinary page is still admitted over ${entry.name}`, {
    timeout: 8000,
  }, async (t) => {
    const wire = openerWire(t, entry, {
      openerUrl: seven,
      reported: ordinary,
      popup: true,
      settled: true,
    });
    const attached = await wire.send('Target.attachToTarget', { targetId: wire.id, flatten: true });
    assert.equal(attached.error, undefined, JSON.stringify(attached));
    const answer = await wire.send(
      'Runtime.evaluate',
      { expression: 'document.title' },
      attached.result.sessionId
    );
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    assert.equal(answer.result.result.value, 'synthetic');
  });
}
