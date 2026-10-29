import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHook } from '../../src/seed/cdp.js';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const seven = 'https://seven.sliccy.ai/os/';
const vault = 'https://vault.sliccy.ai/page';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function navigationProtocol(t, transport) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sliccExtension');
  const sessions = new Map();
  const listeners = new Set();
  const guards = new Set();
  const calls = [];
  let serial = 0;
  let url = ordinary;
  const frame = () => ({
    id: 'protected-navigation-root',
    url,
    securityOrigin: new URL(url).origin,
    loaderId: `loader-${serial}`,
  });
  const info = () => ({ targetId: 'protected-navigation', type: 'page', url });
  const cdp = {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.getTargetInfo') return { targetInfo: info() };
      if (method === 'Target.getTargets') return { targetInfos: [info()] };
      if (method === 'Target.attachToTarget') {
        const attached = `session-${++serial}`;
        sessions.set(attached, params.targetId);
        return { sessionId: attached };
      }
      if (method === 'Target.detachFromTarget') sessions.delete(params.sessionId);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: frame() } };
      if (method === 'Page.getNavigationHistory')
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: ordinary, title: 'ordinary' },
            { id: 2, url, title: 'current' },
          ],
        };
      if (method === 'Runtime.evaluate') return { result: { value: url } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1, nodeName: '#document' } };
      return {};
    },
  };
  Object.defineProperty(globalThis, 'sliccExtension', { configurable: true, value: { cdp } });
  const extension = browserHook(undefined, undefined, new URL(seven).origin);
  t.after(() => {
    for (const guard of guards) guard.close();
    if (prior) Object.defineProperty(globalThis, 'sliccExtension', prior);
    else delete globalThis.sliccExtension;
  });
  return {
    calls,
    async commit(destination) {
      url = destination;
      serial += 1;
      for (const sessionId of sessions.keys())
        for (const listener of listeners)
          listener({ method: 'Page.frameNavigated', sessionId, params: { frame: frame() } });
      for (const listener of listeners)
        listener({ method: 'Target.targetInfoChanged', params: { targetInfo: info() } });
      await flush();
    },
    async connect() {
      const raw = {
        send(text) {
          const { id, method, params, sessionId } = JSON.parse(text);
          void cdp
            .send(method, params, sessionId)
            .then((result) =>
              raw.onmessage?.(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), result }))
            );
        },
        close() {
          off();
        },
      };
      const off =
        transport === 'direct'
          ? cdp.on((message) => raw.onmessage?.(JSON.stringify(message)))
          : () => {};
      const guard =
        transport === 'direct'
          ? guardProtected(raw, new URL(seven).origin)
          : await extension({ runtime: 'extension' });
      guards.add(guard);
      const waiting = new Map();
      let next = 0;
      guard.onmessage = (text) => {
        const message = JSON.parse(text);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      };
      return {
        close: () => guard.close(),
        send(method, params = {}, sessionId) {
          const id = ++next;
          const answer = new Promise((resolve) => waiting.set(id, resolve));
          guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          return answer;
        },
        async attach() {
          return this.send('Target.attachToTarget', {
            targetId: 'protected-navigation',
            flatten: true,
          });
        },
      };
    },
  };
}

function sealed(reply, sessionId, result) {
  if (reply.error) {
    assert.equal(reply.error.message, PROTECTED);
    assert.equal(reply.result, undefined);
  } else {
    assert.deepEqual(reply, { id: reply.id, sessionId, result });
  }
  for (const origin of [new URL(seven).origin, new URL(vault).origin])
    assert.equal(JSON.stringify(reply).includes(origin), false);
}

for (const transport of ['direct', 'extension-browser']) {
  for (const [site, destination] of [
    ['seven', seven],
    ['vault', vault],
  ]) {
    for (const [method, params] of [
      ['Page.enable', {}],
      ['Page.navigate', { url: ordinary }],
      ['Page.reload', {}],
      ['Page.navigateToHistoryEntry', { entryId: 1 }],
    ]) {
      test(`live protected ${site} returns a stand-in tree and refuses ${method} over ${transport}`, {
        timeout: 5000,
      }, async (t) => {
        const wire = navigationProtocol(t, transport);
        const client = await wire.connect();
        const attached = await client.attach();
        assert.equal(attached.error, undefined);
        const session = attached.result.sessionId;
        assert.equal((await client.send('Page.enable', {}, session)).error, undefined);
        await wire.commit(destination);
        const mark = wire.calls.length;
        const tree = await client.send('Page.getFrameTree', {}, session);
        assert.deepEqual(tree, {
          id: tree.id,
          sessionId: session,
          result: {
            frameTree: {
              frame: { id: '0', url: 'chrome-error://chromewebdata/', securityOrigin: '://' },
            },
          },
        });
        sealed(await client.send('Page.getNavigationHistory', {}, session), session, {
          currentIndex: 0,
          entries: [
            {
              id: 0,
              url: 'chrome-error://chromewebdata/',
              userTypedURL: 'chrome-error://chromewebdata/',
              title: '',
            },
          ],
        });
        const refused = await client.send(method, params, session);
        assert.equal(refused.error?.message, PROTECTED);
        assert.equal(refused.result, undefined);
        assert.equal(
          wire.calls.slice(mark).some((call) => call.method === method),
          false,
          'the caller navigation never reaches the backend'
        );
      });
    }
    test(`fresh guard refuses attachment to live protected ${site} over ${transport}`, {
      timeout: 5000,
    }, async (t) => {
      const wire = navigationProtocol(t, transport);
      const first = await wire.connect();
      assert.equal((await first.attach()).error, undefined);
      first.close();
      await wire.commit(destination);
      const fresh = await wire.connect();
      const mark = wire.calls.length;
      const refused = await fresh.attach();
      assert.equal(refused.error?.message, PROTECTED);
      assert.equal(refused.result, undefined);
      assert.equal(
        wire.calls.slice(mark).some((call) => call.method === 'Target.attachToTarget'),
        false,
        'a fresh guard never issues a session for the live protected tab'
      );
    });
  }
}
