import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';

const origin = 'https://seven.sliccy.ai';
const live = `${origin}/os/home`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const link = { kind: 'link', version: '1.60.0' };

function protocol(t, { tabs = new Map() } = {}) {
  const targets = new Map();
  const sessions = new Map();
  const pending = new Map();
  let next = 0;
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, origin, tabs, link);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message) {
    const { id, method, params = {}, sessionId } = message;
    let result = {};
    if (method === 'Target.createTarget') {
      const targetId = `created-${id}`;
      const entry = {
        info: { targetId, type: 'page', url: params.url, title: '' },
        tree: {
          frame: {
            id: targetId,
            url: params.url,
            securityOrigin: new URL(params.url).origin,
          },
        },
      };
      targets.set(targetId, entry);
      result = { targetId };
      queueMicrotask(() =>
        emit({ method: 'Target.targetCreated', params: { targetInfo: { ...entry.info } } })
      );
    }
    if (method === 'Target.attachToTarget') {
      const targetId = params.targetId;
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}-${id}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Target.getTargetInfo') {
      const target = targets.get(params.targetId);
      result = { targetInfo: { ...target.info } };
    }
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((entry) => entry.info) };
    if (method === 'Page.getFrameTree') {
      const targetId = sessions.get(sessionId);
      result = { frameTree: targets.get(targetId).tree };
    }
    if (method === 'Page.getNavigationHistory') {
      const targetId = sessions.get(sessionId);
      const url = targets.get(targetId).info.url;
      result = { currentIndex: 0, entries: [{ id: 1, url, title: '' }] };
    }
    if (method === 'DOM.getDocument')
      result = { root: { nodeId: 1, nodeName: '#document', children: [] } };
    if (method === 'Page.enable' || method === 'Runtime.enable') result = {};
    if (method === 'Target.closeTarget') {
      targets.delete(params.targetId);
      result = { success: true };
    }
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  function userTarget(id, url) {
    const entry = {
      info: { targetId: id, type: 'page', url, title: url },
      tree: {
        frame: { id, url, securityOrigin: new URL(url).origin },
      },
    };
    targets.set(id, entry);
    emit({ method: 'Target.targetCreated', params: { targetInfo: { ...entry.info } } });
    return entry;
  }
  function setUrl(id, url) {
    const entry = targets.get(id);
    entry.info = { ...entry.info, url, title: url };
    entry.tree = {
      frame: { id, url, securityOrigin: new URL(url).origin },
    };
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
  }
  const send = (method, params = {}, sessionId) => {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  };
  return { userTarget, setUrl, send, flush };
}

test('twin: a protected tab the user opened stays close-refused', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.userTarget('user-live', live);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'user-live' });
  console.log(
    `ROW-OBSERVED close-protected-twin ${JSON.stringify({
      kind: 'user-opened',
      closed: !close.error && close.result?.success === true,
      refusal: close.error?.message ?? null,
    })}`
  );
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('twin: a guard-placed tab the client only attached stays close-refused', {
  timeout: 5000,
}, async (t) => {
  const ordinary = 'https://ordinary.invalid/page';
  const wire = protocol(t);
  wire.userTarget('placed-only', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'placed-only',
    flatten: true,
  });
  assert.equal(attached.error, undefined, attached.error?.message);
  wire.setUrl('placed-only', live);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'placed-only' });
  console.log(
    `ROW-OBSERVED close-protected-twin ${JSON.stringify({
      kind: 'guard-placed-attach-only',
      closed: !close.error && close.result?.success === true,
      refusal: close.error?.message ?? null,
    })}`
  );
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('twin: a protected tab the client created is closable', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const created = await wire.send('Target.createTarget', { url: 'about:blank' });
  assert.equal(created.error, undefined, `createTarget: ${created.error?.message}`);
  const targetId = created.result.targetId;
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId });
  console.log(
    `ROW-OBSERVED close-protected-twin ${JSON.stringify({
      kind: 'client-created',
      closed: !close.error && close.result?.success === true,
      refusal: close.error?.message ?? null,
    })}`
  );
  assert.equal(close.error, undefined, `client-created close refused: ${close.error?.message}`);
  assert.equal(close.result?.success, true);
});

test('twin: a tab the client attached and used is closable even after it is protected', {
  timeout: 5000,
}, async (t) => {
  const ordinary = 'https://ordinary.invalid/page';
  const wire = protocol(t);
  wire.userTarget('client-used', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'client-used',
    flatten: true,
  });
  assert.equal(attached.error, undefined, attached.error?.message);
  const session = attached.result.sessionId;
  assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
  wire.setUrl('client-used', live);
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'client-used' });
  console.log(
    `ROW-OBSERVED close-protected-twin ${JSON.stringify({
      kind: 'client-touched',
      closed: !close.error && close.result?.success === true,
      refusal: close.error?.message ?? null,
    })}`
  );
  assert.equal(close.error, undefined, `client-touched close refused: ${close.error?.message}`);
  assert.equal(close.result?.success, true);
});

test('mutant: widening closeProtected makes the user-opened row closable', {
  timeout: 5000,
}, async (t) => {
  const tabs = new Map();
  tabs.widenCloseProtected = true;
  const wire = protocol(t, { tabs });
  wire.userTarget('user-live', live);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'user-live' });
  console.log(
    `ROW-OBSERVED close-protected-mutant ${JSON.stringify({
      kind: 'widen-user-opened',
      closed: !close.error && close.result?.success === true,
      refusal: close.error?.message ?? null,
    })}`
  );
  assert.equal(close.error, undefined, 'mutant must turn the user-opened refuse row red');
  assert.equal(close.result?.success, true);
});
