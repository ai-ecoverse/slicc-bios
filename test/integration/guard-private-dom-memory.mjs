import { guardProtected } from '../../src/seed/guard.js';
import { ownerSnapshot } from './guard-owner-snapshot.mjs';

export function domMemory(t, route = 'extension') {
  const calls = [];
  const frontends = new Map();
  let nextGuard = 0;
  let nextNode = 0;
  let snapshot = ownerSnapshot(
    { nodeName: '#document', backendNodeId: 100, documentURL: 'https://ordinary.invalid/' },
    'root'
  );
  let snapshotError;
  let hold;
  let tree = {
    frame: {
      id: 'root',
      loaderId: 'document',
      url: 'https://ordinary.invalid/',
      securityOrigin: 'https://ordinary.invalid',
    },
  };
  let proof = {
    version: 1,
    revision: 1,
    rootDocumentId: 'native-root',
    rootFrameId: 'root',
    rootLoaderId: 'document',
    localFrames: ['root'],
    remoteOwners: [],
    frames: [
      {
        frameId: 0,
        parentFrameId: -1,
        documentId: 'native-root',
        url: 'https://ordinary.invalid/',
      },
    ],
  };
  function open() {
    const prefix = `connection-${++nextGuard}`;
    const sessions = new Map();
    const pending = new Map();
    let next = 0;
    const raw = {
      send(text) {
        const call = JSON.parse(text);
        calls.push({ ...call, connection: prefix });
        if (call.method === hold) return;
        const key = route === 'extension' ? 'shared-tab' : call.sessionId;
        let result = {};
        let error;
        if (call.method === 'Target.getTargets')
          result = {
            targetInfos: [{ targetId: 'root', type: 'page', url: 'https://ordinary.invalid/' }],
          };
        if (call.method === 'Target.getTargetInfo')
          result = {
            targetInfo: { targetId: 'root', type: 'page', url: 'https://ordinary.invalid/' },
          };
        if (call.method === 'Target.attachToTarget') {
          const sessionId = `${prefix}-${call.id >= 2 ** 30 ? 'guard' : 'client'}-${call.id}`;
          sessions.set(sessionId, 'root');
          result = { sessionId };
        }
        if (call.method === 'Page.getFrameTree') result = { frameTree: tree };
        if (call.method === 'Page.getNavigationHistory')
          result = {
            currentIndex: 0,
            entries: [{ id: 1, url: 'https://ordinary.invalid/', title: 'ordinary' }],
          };
        if (call.method === 'Runtime.evaluate')
          result = { result: { value: 'https://ordinary.invalid/' } };
        if (call.method === 'DOM.getDocument') {
          const nodeId = ++nextNode;
          frontends.set(key, nodeId);
          result = {
            root: {
              nodeType: 9,
              nodeName: '#document',
              nodeId,
              backendNodeId: 100,
              documentURL: 'https://ordinary.invalid/',
              children: [],
            },
          };
        }
        if (call.method === 'DOM.disable') frontends.delete(key);
        if (call.method === 'DOM.querySelectorAll') {
          if (frontends.get(key) !== call.params.nodeId)
            error = { code: -32000, message: 'Could not find node with given id' };
          else result = { nodeIds: [] };
        }
        if (call.method === 'DOMSnapshot.captureSnapshot') {
          result = snapshot;
          if (snapshotError) error = { code: -32601, message: snapshotError };
        }
        queueMicrotask(() =>
          raw.onmessage(
            JSON.stringify({
              id: call.id,
              ...(call.sessionId ? { sessionId: call.sessionId } : {}),
              ...(error ? { error } : { result }),
            })
          )
        );
      },
      close() {},
    };
    const guard = guardProtected(
      raw,
      'https://protected.invalid',
      new Map(),
      { kind: route, version: route === 'extension' ? '7.11.99' : '1.57.99' },
      async () => (typeof proof === 'function' ? proof() : proof)
    );
    const delivered = [];
    guard.onmessage = (text) => {
      const message = JSON.parse(text);
      delivered.push(message);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    };
    t.after(() => guard.close());
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    return {
      send,
      delivered,
      raw,
      async attach() {
        return send('Target.attachToTarget', { targetId: 'root', flatten: true });
      },
    };
  }
  return {
    open,
    calls,
    hold(method) {
      hold = method;
    },
    tree(value) {
      tree = value;
    },
    proof(value) {
      proof = value;
    },
    snapshot(value) {
      snapshot = value;
    },
    fail(value) {
      snapshotError = value;
    },
  };
}
