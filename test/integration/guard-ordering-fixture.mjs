import assert from 'node:assert/strict';
import { guardProtected } from '../../src/seed/guard.js';

export const ordinary = 'https://ordinary.invalid/page';
export const protectedOrigin = 'https://protected.invalid';
export const failed = `${protectedOrigin}/controller/synthetic-ordering-id`;
export const errorFrame = (id, parentId) => ({
  id,
  ...(parentId ? { parentId } : {}),
  url: 'chrome-error://chromewebdata/',
  securityOrigin: '://',
  unreachableUrl: failed,
});
export const plainFrame = (id, parentId) => ({
  id,
  ...(parentId ? { parentId } : {}),
  url: ordinary,
  securityOrigin: new URL(ordinary).origin,
});
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function protocol(t) {
  const targets = new Map();
  const sessions = new Map();
  const sent = [];
  const held = [];
  const pending = new Map();
  const delivered = [];
  let next = 0;
  let hold = () => false;
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      if (hold(message)) return void held.push(message);
      queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, protectedOrigin);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message, payload) {
    const { id, method, params = {}, sessionId } = message;
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    if (method === 'Target.getTargetInfo') result = { targetInfo: target.info };
    if (method === 'Target.attachToTarget') {
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Page.getFrameTree') result = { frameTree: target.tree };
    if (method === 'Page.getNavigationHistory') {
      result = { currentIndex: 0, entries: [{ id: 1, url: target.info.url, title: 'ordinary' }] };
    }
    if (method === 'Runtime.evaluate') result = { result: { value: 'synthetic-content' } };
    if (method === 'Page.captureScreenshot') result = { data: 'c3ludGhldGlj' };
    emit({ id, ...(sessionId ? { sessionId } : {}), ...(payload ?? { result }) });
  }
  function request(method, params = {}, sessionId) {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return { id, answer };
  }
  const send = (method, params, sessionId) => request(method, params, sessionId).answer;
  function target(id, type = 'page', frame = plainFrame(id), parentId) {
    const entry = {
      info: { targetId: id, type, url: frame.url, ...(parentId ? { parentId } : {}) },
      tree: { frame },
    };
    targets.set(id, entry);
    return entry;
  }
  async function attach(id) {
    const answer = await send('Target.attachToTarget', { targetId: id, flatten: true });
    assert.equal(answer.error, undefined);
    await flush();
    return answer.result.sessionId;
  }
  function attached(id, parentSession) {
    const sessionId = `client-${id}`;
    sessions.set(sessionId, id);
    emit({
      method: 'Target.attachedToTarget',
      ...(parentSession ? { sessionId: parentSession } : {}),
      params: { sessionId, targetInfo: targets.get(id).info, waitingForDebugger: false },
    });
    return sessionId;
  }
  const clients = (since = 0) => sent.slice(since).filter((message) => message.id < 2 ** 30);
  function release(message, payload) {
    assert.ok(message, 'a protocol answer is pending');
    held.splice(held.indexOf(message), 1);
    respond(message, payload);
  }
  return {
    targets,
    sessions,
    sent,
    held,
    delivered,
    emit,
    send,
    request,
    target,
    attach,
    attached,
    clients,
    release,
    hold(fn) {
      hold = fn;
    },
  };
}
