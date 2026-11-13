import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { ordinary, protectedOrigin } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

const CROSS = 'https://cross.invalid/inner';
const SECRET = 'iframe-secret-body';
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
    kidParent: 'steady',
  };
  const emit = (message) => {
    for (const listener of listeners) listener(message);
  };
  const infos = () => ({
    owner: { targetId: 'owner', type: 'page', url: state.ownerUrl },
    steady: { targetId: 'steady', type: 'page', url: ordinary },
    kid: { targetId: 'kid', type: 'iframe', url: CROSS, parentId: state.kidParent },
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
      if (method === 'Target.getTargetInfo') return { targetInfo: infos()[params.targetId] };
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
      if (method === 'Page.getFrameTree') return { frameTree: frameTree(target) };
      if (method === 'Page.getNavigationHistory') {
        const url = infos()[target]?.url ?? ordinary;
        return { currentIndex: 0, entries: [{ id: 1, url, title: 'ordinary' }] };
      }
      if (method === 'DOM.getDocument')
        return { root: { nodeId: 1, nodeName: '#document', children: [] } };
      if (method === 'Runtime.evaluate') return { result: { value: SECRET } };
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
  const route = transport === 'link' ? { kind: 'link' } : undefined;
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
  return {
    state,
    delivered,
    sent,
    navigating,
    commit: () => commit(),
    emit,
    send(method, params = {}, sessionId) {
      next += 1;
      const id = next;
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return answer;
    },
  };
}

async function pendingOwner(t, transport) {
  const w = world(t, transport);
  w.state.kidParent = 'owner';
  const created = w.send('Target.createTarget', { url: ordinary });
  await w.navigating;
  return Object.assign(w, { created });
}

const leaks = (delivered, ...values) =>
  values.filter((value) => JSON.stringify(delivered).includes(value));

for (const transport of ['direct', 'link', 'extension']) {
  test(`over ${transport}, an iframe of a createTarget page that has not committed is unlisted, undescribed and unattachable`, {
    timeout: 60000,
  }, async (t) => {
    const w = await pendingOwner(t, transport);
    const listed = await w.send('Target.getTargets');
    assert.ok(
      !(listed.result?.targetInfos ?? []).some((info) => info.targetId === 'kid'),
      'the iframe is not listed'
    );
    assert.match(
      (await w.send('Target.getTargetInfo', { targetId: 'kid' })).error?.message,
      REFUSED
    );
    const attached = await w.send('Target.attachToTarget', { targetId: 'kid', flatten: true });
    assert.match(attached.error?.message ?? '', REFUSED);
    assert.deepEqual(leaks(w.delivered, CROSS, SECRET), []);
    w.commit();
    await w.created;
  });

  test(`over ${transport}, an iframe session refuses commands while its owner is a createTarget page that has not committed`, {
    timeout: 60000,
  }, async (t) => {
    const w = world(t, transport);
    const attached = await w.send('Target.attachToTarget', { targetId: 'kid', flatten: true });
    assert.equal(attached.error, undefined, 'the iframe of an ordinary page attaches');
    const session = attached.result.sessionId;
    const read = () =>
      w.send('Runtime.evaluate', { expression: 'document.body.innerText' }, session);
    assert.equal((await read()).error, undefined, 'and answers');
    w.state.kidParent = 'owner';
    const created = w.send('Target.createTarget', { url: ordinary });
    await w.navigating;
    const refused = await read();
    assert.match(refused.error?.message ?? '', REFUSED);
    assert.equal(
      w.sent.filter((call) => call.method === 'Runtime.evaluate' && call.sessionId === session)
        .length,
      1,
      'the second evaluate never reaches Chrome'
    );
    w.commit();
    await created;
  });

  test(`over ${transport}, an attachment of an iframe under a createTarget page that has not committed is never shown`, {
    timeout: 60000,
  }, async (t) => {
    const w = await pendingOwner(t, transport);
    w.emit({
      method: 'Target.attachedToTarget',
      sessionId: 'owner~99',
      params: {
        sessionId: 'kid~98',
        targetInfo: { targetId: 'kid', type: 'iframe', url: CROSS, parentId: 'owner' },
        waitingForDebugger: false,
      },
    });
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.ok(
      !w.delivered.some(
        (m) => m.method === 'Target.attachedToTarget' && m.params?.sessionId === 'kid~98'
      ),
      'the attachment is not published'
    );
    assert.deepEqual(leaks(w.delivered, CROSS), []);
    w.commit();
    await w.created;
  });

  test(`over ${transport}, an iframe of a createTarget page is admitted once the page's first commit lands, and an iframe of an ordinary committed page keeps working`, {
    timeout: 60000,
  }, async (t) => {
    const w = await pendingOwner(t, transport);
    assert.match(
      (await w.send('Target.attachToTarget', { targetId: 'kid', flatten: true })).error?.message ??
        '',
      REFUSED
    );
    w.commit();
    await w.created;
    w.state.kidParent = 'owner';
    const attached = await w.send('Target.attachToTarget', { targetId: 'kid', flatten: true });
    assert.equal(attached.error, undefined, JSON.stringify(attached.error));
    const read = await w.send(
      'Runtime.evaluate',
      { expression: 'document.body.innerText' },
      attached.result.sessionId
    );
    assert.equal(read.error, undefined);
    assert.equal(read.result?.result?.value ?? read.result?.value, SECRET);
  });
}
