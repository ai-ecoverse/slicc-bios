import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, guardProtected, PROTECTED, UNGUARDED } from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const origin = 'https://seven.sliccy.ai';
const failed = `${origin}/controller/f1-secret`;
const errorPage = 'chrome-error://chromewebdata/';
const HISTORY = "slicc: refused: the target's history may restore a protected document";
const SETUP = new Set([
  'Network.setBypassServiceWorker',
  'DOM.getDocument',
  'DOM.disable',
  'Target.setAutoAttach',
]);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const link = { kind: 'link', version: '1.60.0' };

function protocol(t, { refuseSetup = true, error = true, tabs = new Map() } = {}) {
  const targets = new Map();
  const sessions = new Map();
  const delivered = [];
  const sent = [];
  const pending = new Map();
  let next = 0;
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, origin, tabs, link);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message) {
    const { id, method, params = {}, sessionId } = message;
    if (refuseSetup && SETUP.has(method) && id >= 2 ** 30) {
      emit({
        id,
        ...(sessionId ? { sessionId } : {}),
        error: { code: -32000, message: HISTORY },
      });
      return;
    }
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    if (method === 'Target.attachToTarget') {
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}-${id}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Target.getTargetInfo') result = { targetInfo: { ...target.info } };
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((entry) => entry.info) };
    if (method === 'Page.getFrameTree') result = { frameTree: target.tree };
    if (method === 'Page.getNavigationHistory')
      result = {
        currentIndex: 0,
        entries: [{ id: 1, url: target.info.url, title: target.info.title ?? '' }],
      };
    if (method === 'DOM.getDocument')
      result = { root: { nodeId: 1, nodeName: '#document', children: [] } };
    if (method === 'Runtime.evaluate')
      result = { result: { type: 'string', value: 'f1-secret-content' } };
    if (method === 'Page.reload') result = {};
    if (method === 'Page.navigate') {
      if (params.url === BLANKED || params.url === 'about:blank') {
        target.info = { ...target.info, url: params.url, title: '' };
        target.tree = {
          frame: { id: targetId, url: params.url, securityOrigin: 'null' },
        };
      }
      result = { frameId: targetId };
    }
    if (method === 'Target.closeTarget') {
      targets.delete(params.targetId);
      result = { success: true };
    }
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  function target(id, { asError = error } = {}) {
    const frame = asError
      ? {
          id,
          url: errorPage,
          securityOrigin: '://',
          unreachableUrl: failed,
          loaderId: `${id}-error`,
        }
      : {
          id,
          url: ordinary,
          securityOrigin: new URL(ordinary).origin,
          loaderId: `${id}-ok`,
        };
    const entry = {
      info: { targetId: id, type: 'page', url: frame.url, title: frame.url },
      tree: { frame },
    };
    targets.set(id, entry);
    emit({ method: 'Target.targetCreated', params: { targetInfo: { ...entry.info } } });
    return entry;
  }
  function commitError(id) {
    const entry = targets.get(id);
    entry.tree = {
      frame: {
        id,
        url: errorPage,
        securityOrigin: '://',
        unreachableUrl: failed,
        loaderId: `${id}-error`,
      },
    };
    entry.info = { targetId: id, type: 'page', url: errorPage, title: errorPage };
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
    emit({
      method: 'Page.frameNavigated',
      sessionId: [...sessions].find(([, targetId]) => targetId === id)?.[0],
      params: { frame: entry.tree.frame },
    });
  }
  const send = (method, params = {}, sessionId) => {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  };
  return { target, commitError, send, delivered, sent, emit };
}

async function untilSetup(wire) {
  for (let turn = 0; turn < 80; turn += 1) {
    if (wire.sent.some((message) => message.id >= 2 ** 30 && SETUP.has(message.method))) return;
    await flush();
  }
  assert.fail('bios setup never reached the node');
}

test('link: a node history-restore refusal on an ERROR-PAGE target does not block client attach recovery', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t, { refuseSetup: true, error: true });
  wire.target('error');
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', { targetId: 'error', flatten: true });
  const session = attached.result?.sessionId;
  const setup = [
    ...new Set(
      wire.sent
        .filter((message) => message.id >= 2 ** 30 && SETUP.has(message.method))
        .map((m) => m.method)
    ),
  ];
  const row = {
    id: 'F1.error-page-setup-refusal',
    attach: attached.error?.message ?? 'admitted',
    setup,
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.equal(
    attached.error,
    undefined,
    `attached: got false, want true (${attached.error?.message ?? ''})`
  );
  assert.ok(session, 'attached: got false, want true');
  assert.ok(setup.includes('Network.setBypassServiceWorker'), 'bios setup reached the node');

  const info = await wire.send('Target.getTargetInfo', { targetId: 'error' });
  const listed = await wire.send('Target.getTargets', {});
  const listedInfo = listed.result?.targetInfos?.find((entry) => entry.targetId === 'error');
  assert.equal(info.error, undefined);
  assert.equal(info.result.targetInfo.url, errorPage);
  assert.equal(info.result.targetInfo.title, errorPage);
  assert.equal(listedInfo?.url, errorPage);
  assert.equal(listedInfo?.title, errorPage);
  assert.equal(
    JSON.stringify({ info, listed }).includes('f1-secret'),
    false,
    'infoRedacted: got false, want true'
  );

  const content = await wire.send(
    'Runtime.evaluate',
    { expression: '1', returnByValue: true },
    session
  );
  assert.match(content.error?.message ?? '', /^slicc: refused:/, 'content refused');
  assert.equal(content.result, undefined);
  assert.equal(JSON.stringify(content).includes('f1-secret'), false);

  const reload = await wire.send('Page.reload', {}, session);
  assert.equal(reload.error, undefined, 'reload: got false, want true');
  const blank = await wire.send('Page.navigate', { url: BLANKED }, session);
  assert.equal(blank.error, undefined, 'blank: got false, want true');
  const close = await wire.send('Target.closeTarget', { targetId: 'error' });
  assert.equal(close.error, undefined, 'close: got false, want true');
  assert.equal(close.result?.success, true, 'close: got false, want true');
});

test('link: history-restore refusal before the chrome-error proof waits then admits', {
  timeout: 8000,
}, async (t) => {
  const wire = protocol(t, { refuseSetup: true, error: false });
  wire.target('late', { asError: false });
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const attaching = wire.send('Target.attachToTarget', { targetId: 'late', flatten: true });
  await untilSetup(wire);
  wire.commitError('late');
  const attached = await attaching;
  const row = {
    id: 'F1.history-refusal-before-error-proof',
    attach: attached.error?.message ?? 'admitted',
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.equal(
    attached.error,
    undefined,
    `attached after late proof: ${attached.error?.message ?? ''}`
  );
  assert.ok(attached.result?.sessionId);
});

test('twin: history-restore refusal without an error-page proof stays refused after HISTORY_WAIT', {
  timeout: 12000,
}, async (t) => {
  const wire = protocol(t, { refuseSetup: true, error: false });
  wire.target('never', { asError: false });
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', { targetId: 'never', flatten: true });
  const row = {
    id: 'F1.history-refusal-no-error-proof',
    attach: attached.error?.message ?? 'admitted',
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.equal(attached.error?.message, UNGUARDED);
  assert.equal(attached.result, undefined);
  assert.notEqual(attached.error?.message, PROTECTED);
});

test('mutant: widening link setup refusal admits without an error-page proof', {
  timeout: 5000,
}, async (t) => {
  const tabs = new Map();
  tabs.widenLinkSetupRefusal = true;
  const wire = protocol(t, { refuseSetup: true, error: false, tabs });
  wire.target('wide', { asError: false });
  for (let turn = 0; turn < 4; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', { targetId: 'wide', flatten: true });
  const row = {
    id: 'F1.history-refusal-widen-mutant',
    attach: attached.error?.message ?? 'admitted',
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.equal(attached.error, undefined, 'mutant must turn the no-proof refuse row red');
  assert.ok(attached.result?.sessionId);
});

test('link: a node history-restore refusal on a non-error-page target stays refused', {
  timeout: 12000,
}, async (t) => {
  const wire = protocol(t, { refuseSetup: true, error: false });
  wire.target('ordinary');
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const attached = await wire.send('Target.attachToTarget', {
    targetId: 'ordinary',
    flatten: true,
  });
  const row = {
    id: 'F1.ordinary-setup-refusal',
    attach: attached.error?.message ?? 'admitted',
  };
  console.log(`ROW-OBSERVED ${JSON.stringify(row)}`);
  assert.equal(attached.error?.message, UNGUARDED, 'non-error-page setup refusal must fail closed');
  assert.equal(attached.result, undefined);
  assert.notEqual(attached.error?.message, PROTECTED);
});
