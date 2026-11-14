import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { ordinary, protectedOrigin } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

const CROSS = 'https://cross.invalid/inner';
const WORKER = 'https://cross.invalid/worker.js';
const SECRET = 'worker-secret-body';
const REFUSED = /slicc: refused/;

const frameOf = (id, url, parentId) => ({
  id,
  ...(parentId ? { parentId } : {}),
  url,
  securityOrigin: URL.canParse(url) && url.startsWith('http') ? new URL(url).origin : '://',
  loaderId: `${id}-loader`,
});

function world(t, transport) {
  const listeners = new Set();
  const delivered = [];
  const sent = [];
  const waiting = new Map();
  let sessions = 0;
  let next = 0;
  let commit;
  let begin;
  const navigating = new Promise((resolve) => {
    begin = resolve;
  });
  const state = {
    ownerUrl: 'about:blank',
    ownerFrame: frameOf('owner-frame', 'about:blank'),
    kidParent: 'owner',
    workerParent: 'kid',
  };
  const emit = (message) => {
    for (const listener of listeners) listener(message);
  };
  const infos = () => ({
    owner: { targetId: 'owner', type: 'page', url: state.ownerUrl, openerId: 'steady' },
    steady: { targetId: 'steady', type: 'page', url: ordinary },
    kid: { targetId: 'kid', type: 'iframe', url: CROSS, parentId: state.kidParent },
    worker: { targetId: 'worker', type: 'worker', url: WORKER, parentId: state.workerParent },
  });
  const frameTree = (target) => {
    if (target === 'owner') return { frame: state.ownerFrame };
    if (target === 'steady') return { frame: frameOf('steady-frame', ordinary) };
    const parent = state.kidParent === 'owner' ? 'owner-frame' : 'steady-frame';
    return { frame: frameOf('kid-frame', CROSS, parent) };
  };
  const cdp = {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      const target = sessionId?.split('~')[0];
      if (method === 'Target.createTarget') return { targetId: 'owner' };
      if (method === 'Target.getTargets') return { targetInfos: Object.values(infos()) };
      if (method === 'Target.getTargetInfo')
        return { targetInfo: infos()[params.targetId ?? target] };
      if (method === 'Target.attachToTarget') {
        sessions += 1;
        return { sessionId: `${params.targetId}~${sessions}` };
      }
      if (method === 'Page.navigate' && target === 'owner') {
        begin();
        return new Promise((resolve) => {
          commit = () => {
            state.ownerUrl = ordinary;
            state.ownerFrame = frameOf('owner-frame', ordinary);
            emit({
              method: 'Page.frameNavigated',
              sessionId,
              params: { frame: state.ownerFrame },
            });
            resolve({ frameId: 'owner-frame', loaderId: 'owner-frame-loader' });
          };
        });
      }
      if (method === 'Page.getFrameTree') {
        if (target === 'worker') throw new Error('no frame tree in a worker');
        return { frameTree: frameTree(target) };
      }
      if (method === 'Page.getNavigationHistory') {
        const url = infos()[target]?.url ?? ordinary;
        return { currentIndex: 0, entries: [{ id: 1, url, title: 'ordinary' }] };
      }
      if (method === 'DOM.getDocument')
        return { root: { nodeId: 1, nodeName: '#document', children: [] } };
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: SECRET } };
      return {};
    },
  };
  const raw = {
    send(text) {
      const { id, method, params, sessionId } = JSON.parse(text);
      const reply = (answer) =>
        raw.onmessage(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), ...answer }));
      void cdp.send(method, params, sessionId).then(
        (result) => reply({ result }),
        (error) => reply({ error: { code: -32000, message: error.message } })
      );
    },
    close() {},
  };
  const off = cdp.on((message) => raw.onmessage?.(JSON.stringify(message)));
  const connection = transport === 'extension' ? extensionConnection(cdp) : raw;
  const route =
    transport === 'link'
      ? { kind: 'link' }
      : transport === 'extension'
        ? { kind: 'extension' }
        : undefined;
  const guard = guardProtected(connection, protectedOrigin, new Map(), route);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  t.after(() => {
    guard.close();
    off();
  });
  const evaluated = (session) =>
    sent.some(
      (call) =>
        call.method === 'Runtime.evaluate' &&
        (session ? call.sessionId === session : call.sessionId?.startsWith('worker~'))
    );
  const attachSent = () =>
    sent.some(
      (call) => call.method === 'Target.attachToTarget' && call.params?.targetId === 'worker'
    );
  const shown = (session) =>
    delivered.some(
      (message) =>
        message.method === 'Target.attachedToTarget' && message.params?.sessionId === session
    );
  return {
    state,
    infos,
    delivered,
    sent,
    navigating,
    commit: () => commit(),
    emit,
    evaluated,
    attachSent,
    shown,
    send(method, params = {}, sessionId) {
      next += 1;
      const id = next;
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return answer;
    },
  };
}

async function pendingOwner(t, transport, workerParent) {
  const w = world(t, transport);
  w.state.workerParent = workerParent;
  const created = w.send('Target.createTarget', { url: ordinary });
  await w.navigating;
  return Object.assign(w, { created });
}

const leaks = (delivered, ...values) =>
  values.filter((value) => JSON.stringify(delivered).includes(value));
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const transport of ['direct', 'link', 'extension']) {
  for (const [label, workerParent] of [
    ['an iframe of', 'kid'],
    ['', 'owner'],
  ]) {
    const owner = label ? `${label} a createTarget page` : 'a createTarget page';
    test(`over ${transport}, a worker attachment whose creator is ${owner} that has not committed is never shown and never evaluated`, {
      timeout: 60000,
    }, async (t) => {
      const w = await pendingOwner(t, transport, workerParent);
      w.emit({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'worker~98',
          targetInfo: { ...w.infos().worker, attached: true },
          waitingForDebugger: false,
        },
      });
      await later(2500);
      assert.ok(!w.shown('worker~98'), 'the worker attachment is not published');
      const read = await w.send('Runtime.evaluate', { expression: 'self.secret' }, 'worker~98');
      assert.match(read.error?.message ?? '', REFUSED);
      assert.ok(!w.evaluated(), 'no Runtime.evaluate reaches the worker');
      assert.deepEqual(leaks(w.delivered, WORKER, SECRET), []);
      w.commit();
      await w.created;
    });

    test(`over ${transport}, a worker whose creator is ${owner} that has not committed is not attachable by id`, {
      timeout: 60000,
    }, async (t) => {
      const w = await pendingOwner(t, transport, workerParent);
      const attached = await w.send('Target.attachToTarget', { targetId: 'worker', flatten: true });
      assert.match(attached.error?.message ?? '', REFUSED);
      assert.ok(!w.attachSent(), 'Target.attachToTarget never reaches Chrome');
      assert.ok(!w.evaluated(), 'no Runtime.evaluate reaches the worker');
      assert.deepEqual(leaks(w.delivered, WORKER, SECRET), []);
      w.commit();
      await w.created;
    });

    test(`over ${transport}, a worker whose creator is ${owner} attaches once the page's first commit lands`, {
      timeout: 60000,
    }, async (t) => {
      const w = await pendingOwner(t, transport, workerParent);
      w.commit();
      await w.created;
      const attached = await w.send('Target.attachToTarget', { targetId: 'worker', flatten: true });
      assert.equal(attached.error, undefined, JSON.stringify(attached.error));
      const read = await w.send(
        'Runtime.evaluate',
        { expression: 'self.secret' },
        attached.result.sessionId
      );
      assert.equal(read.error, undefined, JSON.stringify(read.error));
    });
  }

  test(`over ${transport}, a shown worker refuses commands once its iframe moves under a createTarget page that has not committed`, {
    timeout: 60000,
  }, async (t) => {
    const w = world(t, transport);
    w.state.kidParent = 'steady';
    const attached = await w.send('Target.attachToTarget', { targetId: 'kid', flatten: true });
    assert.equal(attached.error, undefined, 'the iframe of an ordinary page attaches');
    const kid = attached.result.sessionId;
    await w.send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'worker' }],
      },
      kid
    );
    w.emit({
      method: 'Target.attachedToTarget',
      sessionId: kid,
      params: {
        sessionId: 'worker~97',
        targetInfo: { ...w.infos().worker, attached: true },
        waitingForDebugger: false,
      },
    });
    for (let i = 0; i < 100 && !w.shown('worker~97'); i++) await later(10);
    assert.ok(w.shown('worker~97'), 'the worker of an ordinary iframe is shown');
    const first = await w.send('Runtime.evaluate', { expression: 'self.secret' }, 'worker~97');
    assert.equal(first.error, undefined, JSON.stringify(first.error));
    const created = w.send('Target.createTarget', { url: ordinary });
    await w.navigating;
    w.state.kidParent = 'owner';
    w.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { ...w.infos().kid, attached: true } },
    });
    await later(50);
    const read = await w.send('Runtime.evaluate', { expression: 'self.secret' }, 'worker~97');
    assert.match(read.error?.message ?? '', REFUSED);
    assert.equal(
      w.sent.filter((call) => call.method === 'Runtime.evaluate' && call.sessionId === 'worker~97')
        .length,
      1,
      'the second evaluate never reaches Chrome'
    );
    w.commit();
    await created;
  });
}
