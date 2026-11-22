import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';
import { hold } from '../../src/seed/held.js';

const origin = 'https://seven.sliccy.ai';
const live = `${origin}/os/home`;
const vault = 'https://vault.sliccy.ai/';
const ordinary = 'https://ordinary.invalid/page';
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
      if (!target) {
        emit({
          id,
          ...(sessionId ? { sessionId } : {}),
          error: { code: -32000, message: `No target with given id found` },
        });
        return;
      }
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
    if (method === 'Runtime.evaluate')
      result = { result: { type: 'number', value: params.returnByValue ? 1 : undefined } };
    if (method === 'Page.navigate') result = { frameId: sessions.get(sessionId) };
    if (method === 'Target.closeTarget') {
      targets.delete(params.targetId);
      result = { success: true };
      queueMicrotask(() =>
        emit({ method: 'Target.targetDestroyed', params: { targetId: params.targetId } })
      );
    }
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  function userTarget(id, url, { openerId } = {}) {
    const entry = {
      info: {
        targetId: id,
        type: 'page',
        url,
        title: url,
        ...(openerId ? { openerId } : {}),
      },
      tree: {
        frame: { id, url, securityOrigin: new URL(url).origin },
      },
    };
    targets.set(id, entry);
    emit({ method: 'Target.targetCreated', params: { targetInfo: { ...entry.info } } });
    return entry;
  }
  function setUrl(id, url, { stranded = false } = {}) {
    const entry = targets.get(id);
    entry.info = { ...entry.info, url, title: url };
    if (stranded || url.startsWith('chrome-error:')) {
      entry.tree = {
        frame: {
          id,
          parentId: `${id}-parent`,
          url: 'chrome-error://chromewebdata/',
          securityOrigin: '://',
          unreachableUrl: live,
        },
      };
      entry.info.url = 'chrome-error://chromewebdata/';
      entry.info.title = 'chrome-error://chromewebdata/';
    } else {
      entry.tree = {
        frame: { id, url, securityOrigin: new URL(url).origin },
      };
    }
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
    const sessionId = [...sessions].find(([, targetId]) => targetId === id)?.[0];
    if (sessionId && entry.tree.frame.url?.startsWith('chrome-error:')) {
      emit({
        method: 'Page.frameNavigated',
        sessionId,
        params: {
          frame: {
            id,
            url: 'chrome-error://chromewebdata/',
            securityOrigin: '://',
            unreachableUrl: live,
          },
        },
      });
    }
  }
  const send = (method, params = {}, sessionId) => {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  };
  return { userTarget, setUrl, send, emit, flush };
}

function observed(kind, close) {
  const row = {
    kind,
    closed: !close.error && close.result?.success === true,
    refusal: close.error?.message ?? null,
  };
  console.log(`ROW-OBSERVED close-protected-twin ${JSON.stringify(row)}`);
  return row;
}

test('twin: a protected tab the user opened stays close-refused', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.userTarget('user-live', live);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'user-live' });
  observed('user-opened', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('twin: a vault tab the user opened stays close-refused', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.userTarget('user-vault', vault);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'user-vault' });
  observed('user-opened-vault', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('twin: a held sign-in tab stays close-refused', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  hold('held-sign-in');
  wire.userTarget('held-sign-in', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'held-sign-in' });
  observed('held-sign-in', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('twin: a tab the client only attached to stays close-refused once protected', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.userTarget('attach-only', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'attach-only',
    flatten: true,
  });
  assert.equal(attached.error, undefined, attached.error?.message);
  wire.setUrl('attach-only', live);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'attach-only' });
  observed('attach-only', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('twin: a driven tab stays close-refused once it shows a protected document', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.userTarget('driven', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'driven',
    flatten: true,
  });
  assert.equal(attached.error, undefined, attached.error?.message);
  assert.equal(
    (
      await wire.send(
        'Runtime.evaluate',
        { expression: '1', returnByValue: true },
        attached.result.sessionId
      )
    ).error,
    undefined
  );
  wire.setUrl('driven', live);
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'driven' });
  observed('driven-then-protected', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('twin: a client-created tab that moved to a protected document stays close-refused', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const created = await wire.send('Target.createTarget', { url: ordinary });
  assert.equal(created.error, undefined, created.error?.message);
  const targetId = created.result.targetId;
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', { targetId, flatten: true });
  assert.equal(attached.error, undefined, attached.error?.message);
  wire.setUrl(targetId, live);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId });
  observed('created-then-moved', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('row: a refused Page.enable on a protected tab does not grant close', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.userTarget('enable-only', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'enable-only',
    flatten: true,
  });
  assert.equal(attached.error, undefined, attached.error?.message);
  const session = attached.result.sessionId;
  wire.setUrl('enable-only', live);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  await wire.send('Page.enable', {}, session);
  const close = await wire.send('Target.closeTarget', { targetId: 'enable-only' });
  observed('refused-command', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('row: two guards on one shared Map; A drives, B close is refused', {
  timeout: 5000,
}, async (t) => {
  const tabs = new Map();
  const a = protocol(t, { tabs });
  a.userTarget('cross-stream', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await a.send('Target.attachToTarget', {
    targetId: 'cross-stream',
    flatten: true,
  });
  assert.equal(attached.error, undefined, attached.error?.message);
  assert.equal(
    (
      await a.send(
        'Runtime.evaluate',
        { expression: '1', returnByValue: true },
        attached.result.sessionId
      )
    ).error,
    undefined
  );
  a.setUrl('cross-stream', live);
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const b = protocol(t, { tabs });
  b.emit({
    method: 'Target.targetCreated',
    params: {
      targetInfo: { targetId: 'cross-stream', type: 'page', url: live, title: live },
    },
  });
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const close = await b.send('Target.closeTarget', { targetId: 'cross-stream' });
  observed('cross-stream-refuse', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});

test('twin: an ordinary tab the client opened closes at once', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const created = await wire.send('Target.createTarget', { url: ordinary });
  assert.equal(created.error, undefined, created.error?.message);
  const targetId = created.result.targetId;
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId });
  observed('ordinary-created', close);
  assert.equal(close.error, undefined, close.error?.message);
  assert.equal(close.result?.success, true);
});

test('twin: an ordinary popup the client opened closes at once', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  wire.userTarget('opener-ordinary', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'opener-ordinary',
    flatten: true,
  });
  assert.equal(attached.error, undefined, attached.error?.message);
  assert.equal(
    (
      await wire.send(
        'Runtime.evaluate',
        { expression: '1', returnByValue: true },
        attached.result.sessionId
      )
    ).error,
    undefined
  );
  wire.userTarget('popup-ordinary', ordinary, { openerId: 'opener-ordinary' });
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'popup-ordinary' });
  observed('ordinary-popup', close);
  assert.equal(close.error, undefined, close.error?.message);
  assert.equal(close.result?.success, true);
});

test('twin: a stranded untouched tab takes the proof path on close', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.userTarget('stranded-attach', ordinary);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  assert.equal(
    (await wire.send('Target.attachToTarget', { targetId: 'stranded-attach', flatten: true }))
      .error,
    undefined
  );
  wire.setUrl('stranded-attach', 'chrome-error://chromewebdata/', { stranded: true });
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const close = await wire.send('Target.closeTarget', { targetId: 'stranded-attach' });
  observed('attach-only-stranded', close);
  assert.equal(close.error?.message, PROTECTED);
  assert.equal(close.result, undefined);
});
