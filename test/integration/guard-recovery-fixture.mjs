import assert from 'node:assert/strict';

const { browserHook } = await import(process.env.CDP_SOURCE ?? '../../src/seed/cdp.js');

export const ordinary = 'https://ordinary.invalid/page';
export const protectedOrigin = 'https://protected.invalid';
export const failed = `${protectedOrigin}/controller/synthetic-recovery`;
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function recoveryProtocol(t, hook = browserHook) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sliccExtension');
  const targets = new Map();
  const sessions = new Map();
  const enabled = new Set();
  const listeners = new Set();
  const guards = new Set();
  const calls = [];
  let serial = 0;
  let pendingTree;
  const emit = (message) => {
    for (const listener of listeners) listener(message);
  };
  const plain = (id, url = ordinary) => ({
    id: `root-${id}`,
    url,
    securityOrigin: new URL(url).origin,
    loaderId: `loader-${++serial}`,
  });
  const target = (id, url = ordinary) => {
    const entry = {
      info: { targetId: id, type: 'page', url, title: 'ordinary' },
      tree: { frame: plain(id, url) },
    };
    targets.set(id, entry);
    return entry;
  };
  const commit = (id, url, { session, loader, origin } = {}) => {
    const entry = targets.get(id);
    const frame = plain(id, url);
    if (loader !== undefined) frame.loaderId = loader;
    if (origin !== undefined) frame.securityOrigin = origin;
    entry.tree = { frame };
    entry.info = { ...entry.info, url, title: 'recovered' };
    for (const [sessionId, owner] of sessions)
      if (owner === id && enabled.has(sessionId) && (!session || session === sessionId))
        emit({ method: 'Page.frameNavigated', sessionId, params: { frame } });
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  };
  const cdp = {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      const id = params.targetId ?? sessions.get(sessionId);
      const entry = targets.get(id);
      if (method === 'Target.getTargets')
        return { targetInfos: [...targets.values()].map((entry) => entry.info) };
      if (method === 'Target.getTargetInfo') return { targetInfo: entry.info };
      if (method === 'Target.createTarget') {
        const id = `created-${++serial}`;
        target(id, params.url);
        return { targetId: id };
      }
      if (method === 'Target.attachToTarget') {
        const attached = `session-${++serial}`;
        sessions.set(attached, id);
        return { sessionId: attached };
      }
      if (method === 'Target.detachFromTarget') {
        sessions.delete(params.sessionId);
        enabled.delete(params.sessionId);
      }
      if (method === 'Page.enable') enabled.add(sessionId);
      if (method === 'Page.getFrameTree') {
        const frameTree = structuredClone(entry.tree);
        const waiting = pendingTree;
        if (waiting) {
          pendingTree = undefined;
          waiting.seen();
          await waiting.ready;
        }
        return { frameTree };
      }
      if (method === 'Page.getNavigationHistory')
        return {
          currentIndex: 0,
          entries: [{ id: 1, url: entry.info.url, title: entry.info.title }],
        };
      if (method === 'DOM.getDocument')
        return { root: { nodeId: 1, nodeName: '#document', children: [] } };
      if (method === 'Page.navigate') {
        if (params.url !== 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E')
          commit(id, params.url);
        return { frameId: entry.tree.frame.id, loaderId: entry.tree.frame.loaderId };
      }
      if (method === 'Runtime.evaluate')
        return { result: { type: 'string', value: `${entry.info.url} ${entry.info.title}` } };
      if (method === 'Accessibility.getFullAXTree')
        return {
          nodes: [{ nodeId: '1', role: { value: 'heading' }, name: { value: entry.info.title } }],
        };
      return {};
    },
  };
  Object.defineProperty(globalThis, 'sliccExtension', { configurable: true, value: { cdp } });
  const open = hook(undefined, undefined, protectedOrigin);
  t.after(() => {
    for (const guard of guards) guard.close();
    if (prior) Object.defineProperty(globalThis, 'sliccExtension', prior);
    else delete globalThis.sliccExtension;
  });
  return {
    calls,
    targets,
    sessions,
    target,
    commit,
    emit,
    pauseTree() {
      let seen;
      let release;
      const requested = new Promise((resolve) => {
        seen = resolve;
      });
      const ready = new Promise((resolve) => {
        release = resolve;
      });
      pendingTree = { seen, ready };
      return { requested, release };
    },
    blocked(id, observed = true) {
      const entry = targets.get(id);
      entry.info = { ...entry.info, url: failed, title: 'synthetic error' };
      entry.tree = {
        frame: {
          id: `root-${id}`,
          url: 'chrome-error://chromewebdata/',
          securityOrigin: '://',
          unreachableUrl: failed,
          loaderId: `error-${++serial}`,
        },
      };
      if (observed)
        for (const [sessionId, owner] of sessions)
          if (owner === id && enabled.has(sessionId))
            emit({ method: 'Page.frameNavigated', sessionId, params: { frame: entry.tree.frame } });
      emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    },
    replaceBrowser() {
      Object.defineProperty(globalThis, 'sliccExtension', {
        configurable: true,
        value: { cdp: { ...cdp } },
      });
    },
    async connect() {
      const guard = await open({ runtime: 'extension' });
      guards.add(guard);
      const waiting = new Map();
      const delivered = [];
      let next = 0;
      guard.onmessage = (text) => {
        const message = JSON.parse(text);
        delivered.push(message);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      };
      return {
        delivered,
        close: () => guard.close(),
        async send(method, params = {}, sessionId) {
          const id = ++next;
          const answer = new Promise((resolve) => waiting.set(id, resolve));
          guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          return answer;
        },
        async attach(id) {
          const answer = await this.send('Target.attachToTarget', { targetId: id, flatten: true });
          assert.equal(answer.error, undefined);
          return answer.result.sessionId;
        },
      };
    },
  };
}
