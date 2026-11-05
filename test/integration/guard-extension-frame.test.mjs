import assert from 'node:assert/strict';
import { test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { guardProtected, PRESENT_REFUSAL, PROTECTED, SHOWN_REFUSAL } from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const foreign = 'chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/completion_list.html';
const ownExt = 'chrome-extension://ownextensionid000000000000000000/frame.html';
const seven = 'https://seven.sliccy.ai/app';
const vault = 'https://vault.sliccy.ai/';
const chrome = 'chrome://settings/';
const extensionOrigin = (url) => {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
};
const { whenShown, whilePresent } = catalog.protectedOrigins.extensionFrames;

const flush = () => new Promise((resolve) => setImmediate(resolve));

function protocol(t, own = 'https://protected.invalid') {
  const targets = new Map();
  const sessions = new Map();
  const sent = [];
  const pending = new Map();
  const delivered = [];
  const answers = new Map();
  let next = 0;
  const key = (id, sessionId) => JSON.stringify([sessionId ?? null, id]);
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      sent.push(message);
      queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, own);
  guard.onmessage = (text) => {
    const message = JSON.parse(text);
    delivered.push(message);
    pending.get(key(message.id, message.sessionId))?.(message);
    pending.delete(key(message.id, message.sessionId));
  };
  t.after(() => guard.close());
  const emit = (message) => raw.onmessage(JSON.stringify(message));
  function respond(message) {
    const { id, method, params = {}, sessionId } = message;
    if (id >= 2 ** 30 && answers.has(method)) {
      const payload = answers.get(method)(message);
      void Promise.resolve(payload).then((body) =>
        emit({ id, ...(sessionId ? { sessionId } : {}), ...body })
      );
      return;
    }
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    if (method === 'Target.getTargetInfo') result = { targetInfo: target.info };
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((entry) => entry.info) };
    if (method === 'Target.attachToTarget') {
      if (target?.info.url?.startsWith('chrome-extension:') && id < 2 ** 30) {
        return emit({
          id,
          ...(sessionId ? { sessionId } : {}),
          error: { code: -32000, message: PROTECTED },
        });
      }
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Page.getFrameTree') result = { frameTree: target.tree };
    if (method === 'Page.getNavigationHistory')
      result = {
        currentIndex: 0,
        entries: [{ id: 1, url: target.info.url, title: 'ordinary' }],
      };
    if (method === 'DOM.getDocument')
      result = {
        root: {
          nodeId: 1,
          nodeName: '#document',
          children: target.owners ?? [],
        },
      };
    if (method === 'DOMSnapshot.captureSnapshot') result = { documents: [], strings: [] };
    if (method === 'Page.captureScreenshot') result = { data: 'c3ludGhldGlj' };
    if (method === 'Page.startScreencast') result = {};
    if (method === 'Page.stopScreencast') result = {};
    if (method === 'Page.captureSnapshot') result = { data: '<html></html>' };
    if (method === 'Page.printToPDF') result = { data: 'cGRm' };
    if (method === 'HeadlessExperimental.beginFrame') result = {};
    if (method === 'Network.getResponseBody') result = { body: '', base64Encoded: false };
    if (method === 'Runtime.evaluate')
      result = answers.get('Runtime.evaluate')?.(message)?.result ?? {
        result: { type: 'string', value: ordinary },
      };
    if (answers.has(method) && id < 2 ** 30) {
      const payload = answers.get(method)(message);
      return emit({ id, ...(sessionId ? { sessionId } : {}), ...payload });
    }
    if (method === 'Input.dispatchKeyEvent' || method.startsWith('Input.')) result = {};
    if (method === 'Page.createIsolatedWorld') result = { executionContextId: 7 };
    if (method === 'DOM.getFrameOwner') result = { backendNodeId: 9 };
    if (method === 'DOM.resolveNode')
      result = { object: { objectId: 'ext-frame-object', type: 'object' } };
    if (method === 'Runtime.callFunctionOn')
      result = answers.get('Runtime.callFunctionOn')?.(message)?.result ?? {
        result: { type: 'boolean', value: false },
      };
    if (method === 'Runtime.releaseObjectGroup') result = {};
    if (method === 'Page.enable' || method === 'DOM.disable' || method === 'Target.setAutoAttach') {
      result = {};
      if (method === 'Target.setAutoAttach' && params.autoAttach) {
        for (const [tid, entry] of targets) {
          if (entry.oopif && entry.info.parentId === sessions.get(sessionId)) {
            const childSession = `guard-${tid}`;
            sessions.set(childSession, tid);
            emit({
              method: 'Target.attachedToTarget',
              sessionId,
              params: {
                sessionId: childSession,
                targetInfo: entry.info,
                waitingForDebugger: false,
              },
            });
          }
        }
      }
    }
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  function request(method, params = {}, sessionId, id = ++next) {
    const answer = new Promise((resolve) => pending.set(key(id, sessionId), resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  }
  function childOrigin(url) {
    return url.startsWith('chrome-extension:')
      ? extensionOrigin(url)
      : URL.canParse(url)
        ? new URL(url).origin
        : url;
  }
  function target(id, url = ordinary, child, options = {}) {
    const childFrameId = options.frameId ?? (child ? `${id}-ext` : undefined);
    const frame = {
      id,
      url,
      securityOrigin: URL.canParse(url) ? new URL(url).origin : url,
    };
    const nested = options.nested;
    const tree = child
      ? {
          frame,
          childFrames: [
            {
              frame: {
                id: childFrameId,
                parentId: id,
                url: child,
                securityOrigin: childOrigin(child),
              },
            },
          ],
        }
      : { frame };
    const owners = child
      ? [
          {
            nodeId: 2,
            nodeName: 'IFRAME',
            frameId: childFrameId,
            attributes: ['src', child],
          },
        ]
      : [];
    const entry = {
      info: { targetId: id, type: 'page', url },
      tree,
      owners,
    };
    targets.set(id, entry);
    if (child && options.oopif) {
      const childTree = {
        frame: {
          id: childFrameId,
          parentId: id,
          url: child,
          securityOrigin: childOrigin(child),
        },
      };
      if (nested) {
        childTree.childFrames = [
          {
            frame: {
              id: `${childFrameId}-nested`,
              parentId: childFrameId,
              url: nested,
              securityOrigin: childOrigin(nested),
            },
          },
        ];
      }
      targets.set(childFrameId, {
        oopif: true,
        info: { targetId: childFrameId, type: 'iframe', url: child, parentId: id },
        tree: childTree,
        owners: [],
      });
    } else if (child) {
      targets.set(`${id}-ext-target`, {
        info: { targetId: `${id}-ext-target`, type: 'iframe', url: child, parentId: id },
        tree: {
          frame: {
            id: childFrameId,
            parentId: id,
            url: child,
            securityOrigin: childOrigin(child),
          },
        },
      });
    }
    return entry;
  }
  async function attach(id) {
    const answer = await request('Target.attachToTarget', { targetId: id, flatten: true });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    await flush();
    await flush();
    return answer.result.sessionId;
  }
  return {
    request,
    target,
    attach,
    delivered,
    sent,
    answers,
    emit,
    guard,
    targets,
    sessions,
  };
}

test('a foreign extension frame does not lock an ordinary tab', async (t) => {
  const wire = protocol(t);
  wire.target('foreign-open', ordinary, foreign);
  const session = await wire.attach('foreign-open');
  const read = await wire.request(
    'Runtime.evaluate',
    { expression: 'document.title', returnByValue: true },
    session
  );
  assert.equal(read.error, undefined, JSON.stringify(read));
  assert.equal(read.result.result.value, ordinary);
});

test('an OOPIF extension frame leaves the tab readable', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('oopif-ext', ordinary, foreign, { oopif: true, frameId: 'oopif-ext-frame' });
  const session = await wire.attach('oopif-ext');
  const document = await wire.request('DOM.getDocument', { depth: -1 }, session);
  assert.equal(document.error, undefined, JSON.stringify(document));
  assert.equal(
    JSON.stringify(document.result).includes('chrome-extension://'),
    false,
    JSON.stringify(document.result)
  );
  const shot = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(shot.error, undefined, JSON.stringify(shot));
});

test('a pending foreign extension OOPIF does not lock its parent tab', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('oopif-pending', ordinary, foreign, {
    oopif: true,
    frameId: 'oopif-pending-frame',
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  wire.answers.set('Page.getFrameTree', (message) => {
    if (message.sessionId === 'guard-oopif-pending-frame')
      return held.then(() => ({
        result: { frameTree: wire.targets.get('oopif-pending-frame').tree },
      }));
    const targetId = wire.sessions.get(message.sessionId);
    return { result: { frameTree: wire.targets.get(targetId).tree } };
  });
  const attaching = wire.attach('oopif-pending');
  await flush();
  await flush();
  release();
  const session = await attaching;
  const document = await wire.request('DOM.getDocument', { depth: -1 }, session);
  assert.equal(document.error, undefined, JSON.stringify(document));
  const shot = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(shot.error, undefined, JSON.stringify(shot));
});

test('a failed foreign extension OOPIF does not lock its parent tab', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('oopif-failed', ordinary, foreign, {
    oopif: true,
    frameId: 'oopif-failed-frame',
  });
  wire.answers.set('DOMSnapshot.captureSnapshot', (message) => {
    if (message.sessionId === 'guard-oopif-failed-frame')
      return { error: { code: -32000, message: 'owners failed' } };
    return { result: { documents: [], strings: [] } };
  });
  const session = await wire.attach('oopif-failed');
  await flush();
  await flush();
  const document = await wire.request('DOM.getDocument', { depth: -1 }, session);
  assert.equal(document.error, undefined, JSON.stringify(document));
  const snap = await wire.request('Page.captureSnapshot', {}, session);
  assert.equal(snap.error?.message, PRESENT_REFUSAL);
});

test('an unready ordinary iframe OOPIF locks its parent tab', async (t) => {
  const wire = protocol(t);
  const child = 'https://ordinary.invalid/iframe';
  wire.target('oopif-https', ordinary, child, {
    oopif: true,
    frameId: 'oopif-https-frame',
  });
  wire.answers.set('Page.getFrameTree', (message) => {
    if (message.sessionId === 'guard-oopif-https-frame')
      return { error: { code: -32000, message: 'frame tree unavailable' } };
    const targetId = wire.sessions.get(message.sessionId);
    return { result: { frameTree: wire.targets.get(targetId).tree } };
  });
  const session = await wire.attach('oopif-https');
  await flush();
  await flush();
  const document = await wire.request('DOM.getDocument', { depth: -1 }, session);
  assert.equal(document.error?.message, PROTECTED);
});

test('an unready protected iframe OOPIF locks its parent tab', async (t) => {
  const wire = protocol(t);
  wire.target('oopif-seven', ordinary, seven, {
    oopif: true,
    frameId: 'oopif-seven-frame',
  });
  wire.answers.set('Page.getFrameTree', (message) => {
    if (message.sessionId === 'guard-oopif-seven-frame')
      return { error: { code: -32000, message: 'frame tree unavailable' } };
    const targetId = wire.sessions.get(message.sessionId);
    return { result: { frameTree: wire.targets.get(targetId).tree } };
  });
  const attached = await wire.request('Target.attachToTarget', {
    targetId: 'oopif-seven',
    flatten: true,
  });
  if (attached.error) {
    assert.equal(attached.error.message, PROTECTED);
    return;
  }
  await flush();
  await flush();
  const document = await wire.request('DOM.getDocument', { depth: -1 }, attached.result.sessionId);
  assert.equal(document.error?.message, PROTECTED);
});

test('an unready own-extension OOPIF locks its parent tab', async (t) => {
  const wire = protocol(t, [
    'https://protected.invalid',
    'chrome-extension://ownextensionid000000000000000000',
  ]);
  wire.target('oopif-own', ordinary, ownExt, {
    oopif: true,
    frameId: 'oopif-own-frame',
  });
  wire.answers.set('Page.getFrameTree', (message) => {
    if (message.sessionId === 'guard-oopif-own-frame')
      return { error: { code: -32000, message: 'frame tree unavailable' } };
    const targetId = wire.sessions.get(message.sessionId);
    return { result: { frameTree: wire.targets.get(targetId).tree } };
  });
  const attached = await wire.request('Target.attachToTarget', {
    targetId: 'oopif-own',
    flatten: true,
  });
  if (attached.error) {
    assert.equal(attached.error.message, PROTECTED);
    return;
  }
  await flush();
  await flush();
  const document = await wire.request('DOM.getDocument', { depth: -1 }, attached.result.sessionId);
  assert.equal(document.error?.message, PROTECTED);
});

function armForeignExtensionRace(wire, pageId, childId = `${pageId}-race-frame`) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  wire.targets.set(childId, {
    oopif: true,
    info: { targetId: childId, type: 'iframe', url: foreign, parentId: pageId },
    tree: {
      frame: {
        id: childId,
        parentId: pageId,
        url: foreign,
        securityOrigin: extensionOrigin(foreign),
      },
    },
    owners: [],
  });
  let raced = false;
  wire.answers.set('Page.getFrameTree', (message) => {
    if (message.sessionId === `guard-${childId}`)
      return held.then(() => ({
        result: { frameTree: wire.targets.get(childId).tree },
      }));
    const targetId = wire.sessions.get(message.sessionId);
    if (targetId === pageId && !raced) {
      raced = true;
      wire.sessions.set(`guard-${childId}`, childId);
      wire.emit({
        method: 'Target.attachedToTarget',
        sessionId: `guard-${pageId}`,
        params: {
          sessionId: `guard-${childId}`,
          targetInfo: wire.targets.get(childId).info,
          waitingForDebugger: false,
        },
      });
    }
    return { result: { frameTree: wire.targets.get(targetId).tree } };
  });
  return { release, childId };
}

test('Page.captureScreenshot refuses when a foreign extension OOPIF attaches mid-command', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('race-shot', ordinary);
  const session = await wire.attach('race-shot');
  const { release } = armForeignExtensionRace(wire, 'race-shot');
  const shot = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(shot.error?.message, SHOWN_REFUSAL);
  assert.equal(
    wire.sent.some(
      (message) => message.method === 'Page.captureScreenshot' && message.sessionId === session
    ),
    false
  );
  release();
  await flush();
  await flush();
  const after = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(after.error, undefined, JSON.stringify(after));
});

test('Page.captureSnapshot refuses when a foreign extension OOPIF attaches mid-command', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('race-snap', ordinary);
  const session = await wire.attach('race-snap');
  const { release } = armForeignExtensionRace(wire, 'race-snap');
  const snap = await wire.request('Page.captureSnapshot', {}, session);
  assert.equal(snap.error?.message, PRESENT_REFUSAL);
  assert.equal(
    wire.sent.some(
      (message) => message.method === 'Page.captureSnapshot' && message.sessionId === session
    ),
    false
  );
  release();
});

test('Input.dispatchMouseEvent refuses when a foreign extension OOPIF attaches mid-command', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('race-input', ordinary);
  const session = await wire.attach('race-input');
  const { release } = armForeignExtensionRace(wire, 'race-input');
  const input = await wire.request(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 },
    session
  );
  assert.equal(input.error?.message, SHOWN_REFUSAL);
  assert.equal(
    wire.sent.some(
      (message) => message.method === 'Input.dispatchMouseEvent' && message.sessionId === session
    ),
    false
  );
  release();
  await flush();
  await flush();
  const after = await wire.request(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 },
    session
  );
  assert.equal(after.error, undefined, JSON.stringify(after));
});

test('a running screencast stops when an unready foreign extension OOPIF attaches', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('cast-oopif', ordinary);
  const session = await wire.attach('cast-oopif');
  const started = await wire.request('Page.startScreencast', { format: 'png' }, session);
  assert.equal(started.error, undefined);
  const before = wire.sent.length;
  const childId = 'cast-oopif-frame';
  wire.targets.set(childId, {
    oopif: true,
    info: { targetId: childId, type: 'iframe', url: foreign, parentId: 'cast-oopif' },
    tree: {
      frame: {
        id: childId,
        parentId: 'cast-oopif',
        url: foreign,
        securityOrigin: extensionOrigin(foreign),
      },
    },
    owners: [],
  });
  wire.sessions.set(`guard-${childId}`, childId);
  wire.emit({
    method: 'Target.attachedToTarget',
    sessionId: session,
    params: {
      sessionId: `guard-${childId}`,
      targetInfo: wire.targets.get(childId).info,
      waitingForDebugger: false,
    },
  });
  await flush();
  assert.ok(
    wire.sent.slice(before).some((message) => message.method === 'Page.stopScreencast'),
    'stopScreencast was sent'
  );
});

test('an OOPIF extension screenshot follows the shown rule', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: true } },
  }));
  wire.target('oopif-shown', ordinary, foreign, { oopif: true, frameId: 'oopif-shown-frame' });
  const session = await wire.attach('oopif-shown');
  const shot = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(shot.error?.message, SHOWN_REFUSAL);
});

test('a protected frame nested inside an extension OOPIF locks the tab', async (t) => {
  const wire = protocol(t);
  wire.target('oopif-nested', ordinary, foreign, {
    oopif: true,
    frameId: 'oopif-nested-frame',
    nested: seven,
  });
  const session = await wire.attach('oopif-nested');
  const document = await wire.request('DOM.getDocument', { depth: -1 }, session);
  assert.equal(document.error?.message, PROTECTED);
});

test('a client attach to an extension OOPIF target stays refused', async (t) => {
  const wire = protocol(t);
  wire.target('oopif-attach', ordinary, foreign, {
    oopif: true,
    frameId: 'oopif-attach-frame',
  });
  await wire.attach('oopif-attach');
  const answer = await wire.request('Target.attachToTarget', {
    targetId: 'oopif-attach-frame',
    flatten: true,
  });
  assert.equal(answer.error?.message, PROTECTED);
});

test('a top-level foreign extension navigation cuts the session', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('root-ext-walk', ordinary);
  const session = await wire.attach('root-ext-walk');
  entry.info.url = foreign;
  entry.tree = {
    frame: {
      id: 'root-ext-walk',
      url: foreign,
      securityOrigin: extensionOrigin(foreign),
      loaderId: 'ext-loader',
    },
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: 'root-ext-walk',
        url: foreign,
        securityOrigin: extensionOrigin(foreign),
        loaderId: 'ext-loader',
      },
    },
  });
  await flush();
  const read = await wire.request(
    'Runtime.evaluate',
    { expression: '1', returnByValue: true },
    session
  );
  assert.ok(read.error, JSON.stringify(read));
});

test('targetInfoChanged to a top-level foreign extension page cuts', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('root-ext-hint', ordinary);
  const session = await wire.attach('root-ext-hint');
  entry.info.url = foreign;
  entry.tree = {
    frame: {
      id: 'root-ext-hint',
      url: foreign,
      securityOrigin: extensionOrigin(foreign),
      loaderId: 'hint-loader',
    },
  };
  wire.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { ...entry.info, url: foreign } },
  });
  await flush();
  await flush();
  const read = await wire.request(
    'Runtime.evaluate',
    { expression: '1', returnByValue: true },
    session
  );
  assert.ok(read.error, JSON.stringify(read));
});

test('a root default world with a foreign extension origin is protected', async (t) => {
  const wire = protocol(t);
  wire.target('root-ext-world', ordinary);
  const session = await wire.attach('root-ext-world');
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 11,
        origin: extensionOrigin(foreign),
        auxData: { isDefault: true, type: 'default', frameId: 'root-ext-world' },
      },
    },
  });
  await flush();
  const read = await wire.request(
    'Runtime.evaluate',
    { expression: '1', returnByValue: true },
    session
  );
  assert.ok(read.error, JSON.stringify(read));
});

test('frameId commands on an embedded extension frame stay refused', async (t) => {
  const wire = protocol(t);
  wire.target('frame-ext-id', ordinary, foreign);
  const session = await wire.attach('frame-ext-id');
  const answer = await wire.request(
    'Page.createIsolatedWorld',
    { frameId: 'frame-ext-id-ext', worldName: 'client' },
    session
  );
  assert.equal(answer.error?.message, PROTECTED);
});

test('embedded foreign extension document requests do not cut the tab', async (t) => {
  const wire = protocol(t);
  wire.target('embed-doc', ordinary, foreign);
  const session = await wire.attach('embed-doc');
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'e1',
      type: 'Document',
      frameId: 'embed-doc-ext',
      request: { url: foreign },
    },
  });
  await flush();
  const read = await wire.request(
    'Runtime.evaluate',
    { expression: '1', returnByValue: true },
    session
  );
  assert.equal(read.error, undefined, JSON.stringify(read));
});

test("seven's own extension frame still locks the tab", async (t) => {
  const wire = protocol(t, [
    'https://protected.invalid',
    'chrome-extension://ownextensionid000000000000000000',
  ]);
  wire.target('own-lock', ordinary, ownExt);
  const attached = await wire.request('Target.attachToTarget', {
    targetId: 'own-lock',
    flatten: true,
  });
  if (attached.error) {
    assert.equal(attached.error.message, PROTECTED);
    return;
  }
  await flush();
  const read = await wire.request(
    'Runtime.evaluate',
    { expression: '1', returnByValue: true },
    attached.result.sessionId
  );
  assert.equal(read.error?.message, PROTECTED);
});

test('seven, vault and another protected scheme still lock', async (t) => {
  for (const [id, url] of [
    ['seven-lock', seven],
    ['vault-lock', vault],
    ['chrome-lock', chrome],
  ]) {
    const wire = protocol(t);
    wire.target(id, ordinary, url);
    const attached = await wire.request('Target.attachToTarget', { targetId: id, flatten: true });
    if (attached.error) {
      assert.equal(attached.error.message, PROTECTED, url);
      continue;
    }
    await flush();
    const read = await wire.request(
      'Runtime.evaluate',
      { expression: '1', returnByValue: true },
      attached.result.sessionId
    );
    assert.equal(read.error?.message, PROTECTED, url);
  }
});

test('hidden unfocused extension frame admits whenShown input', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('hidden-in', ordinary, foreign);
  const session = await wire.attach('hidden-in');
  for (const method of whenShown.filter((name) => name.startsWith('Input.'))) {
    const answer = await wire.request(method, {}, session);
    assert.equal(answer.error, undefined, method);
  }
});

test('hidden focused extension frame refuses whenShown with shownRefusal', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: true } },
  }));
  wire.target('hidden-focus', ordinary, foreign);
  const session = await wire.attach('hidden-focus');
  const answer = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'a' },
    session
  );
  assert.equal(answer.error?.message, SHOWN_REFUSAL);
});

test('shown transparent and offscreen refuse whenShown with shownRefusal', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: true } },
  }));
  wire.target('shown-in', ordinary, foreign);
  const session = await wire.attach('shown-in');
  for (const method of ['Page.captureScreenshot', 'Input.insertText']) {
    const answer = await wire.request(
      method,
      method === 'Input.insertText' ? { text: 'x' } : {},
      session
    );
    assert.equal(answer.error?.message, SHOWN_REFUSAL, method);
  }
});

test('a visibility check error or timeout refuses with shownRefusal', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    error: { code: -32000, message: 'probe failed' },
  }));
  wire.target('check-err', ordinary, foreign);
  const session = await wire.attach('check-err');
  const answer = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(answer.error?.message, SHOWN_REFUSAL);
});

test('whilePresent captures refuse with presentRefusal', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('present-in', ordinary, foreign);
  const session = await wire.attach('present-in');
  for (const method of whilePresent) {
    const answer = await wire.request(method, {}, session);
    assert.equal(answer.error?.message, PRESENT_REFUSAL, method);
  }
});

test('a running screencast is stopped when an extension frame appears', async (t) => {
  const wire = protocol(t);
  wire.target('cast-stop', ordinary);
  const session = await wire.attach('cast-stop');
  const started = await wire.request('Page.startScreencast', { format: 'png' }, session);
  assert.equal(started.error, undefined);
  const before = wire.sent.length;
  wire.target('cast-stop', ordinary, foreign);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: 'cast-stop-ext',
        parentId: 'cast-stop',
        url: foreign,
        securityOrigin: extensionOrigin(foreign),
      },
    },
  });
  await flush();
  wire.emit({
    method: 'Page.screencastFrame',
    sessionId: session,
    params: {
      data: 'x',
      sessionId: 1,
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 1,
        deviceHeight: 1,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        timestamp: 1,
      },
    },
  });
  await flush();
  assert.equal(
    wire.delivered.some((message) => message.method === 'Page.screencastFrame'),
    false
  );
  assert.ok(
    wire.sent.slice(before).some((message) => message.method === 'Page.stopScreencast'),
    'stopScreencast was sent'
  );
});

test('extension frame URLs are redacted from read methods', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.answers.set('Runtime.evaluate', () => ({
    result: { result: { type: 'string', value: foreign } },
  }));
  wire.target('redact-in', ordinary, foreign);
  const session = await wire.attach('redact-in');
  const evaluated = await wire.request(
    'Runtime.evaluate',
    { expression: 'document.querySelector("iframe").src', returnByValue: true },
    session
  );
  assert.equal(evaluated.error, undefined);
  assert.equal(evaluated.result.result.value, 'about:blank');
  const tree = await wire.request('Page.getFrameTree', {}, session);
  assert.equal(tree.error, undefined);
  assert.equal(
    JSON.stringify(tree.result).includes('chrome-extension://'),
    false,
    JSON.stringify(tree.result)
  );
  const listed = await wire.request('Target.getTargets', {});
  assert.equal(
    JSON.stringify(listed.result).includes('chrome-extension://'),
    false,
    JSON.stringify(listed.result)
  );
  const document = await wire.request('DOM.getDocument', { depth: -1 }, session);
  assert.equal(document.error, undefined);
  assert.equal(
    JSON.stringify(document.result).includes('chrome-extension://'),
    false,
    JSON.stringify(document.result)
  );
});

test('base64Encoded CONTENTS that name the vault are refused', async (t) => {
  const wire = protocol(t);
  wire.target('b64-vault', ordinary);
  const session = await wire.attach('b64-vault');
  const body = Buffer.from(`hello ${vault}secret world`).toString('base64');
  wire.answers.set('Page.getResourceContent', () => ({
    result: { content: body, base64Encoded: true },
  }));
  const answer = await wire.request(
    'Page.getResourceContent',
    { frameId: 'b64-vault', url: ordinary },
    session
  );
  assert.equal(answer.error?.message, PROTECTED);
});

test('quoted-printable CONTENTS that name the vault are refused', async (t) => {
  const wire = protocol(t);
  wire.target('qp-vault', ordinary);
  const session = await wire.attach('qp-vault');
  const data = `Content-Transfer-Encoding: quoted-printable\r\nhttps://vault.sliccy.ai/sec=\r\nret`;
  wire.answers.set('Page.captureSnapshot', () => ({
    result: { data },
  }));
  const answer = await wire.request('Page.captureSnapshot', { format: 'mhtml' }, session);
  assert.equal(answer.error?.message, PROTECTED);
});

test('whenShown reuses one isolated world per frame and loader', async (t) => {
  const wire = protocol(t);
  let worlds = 0;
  let nextContext = 40;
  wire.answers.set('Page.createIsolatedWorld', () => {
    worlds += 1;
    nextContext += 1;
    return { result: { executionContextId: nextContext } };
  });
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('reuse-world', ordinary, foreign);
  const session = await wire.attach('reuse-world');
  for (let i = 0; i < 3; i += 1) {
    const answer = await wire.request(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'a' },
      session
    );
    assert.equal(answer.error, undefined);
  }
  assert.equal(worlds, 1);
});

test('a stale probe context is dropped so the next whenShown makes a new world', async (t) => {
  const wire = protocol(t);
  let worlds = 0;
  let nextContext = 50;
  let resolveFails = 1;
  wire.answers.set('Page.createIsolatedWorld', () => {
    worlds += 1;
    nextContext += 1;
    return { result: { executionContextId: nextContext } };
  });
  wire.answers.set('DOM.resolveNode', () => {
    if (resolveFails > 0) {
      resolveFails -= 1;
      return { error: { code: -32000, message: 'Cannot find context with specified id' } };
    }
    return { result: { object: { objectId: 'ext-frame-object', type: 'object' } } };
  });
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('stale-world', ordinary, foreign);
  const session = await wire.attach('stale-world');
  const first = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'a' },
    session
  );
  assert.equal(first.error?.message, SHOWN_REFUSAL);
  assert.equal(worlds, 1);
  const second = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'b' },
    session
  );
  assert.equal(second.error, undefined);
  assert.equal(worlds, 2);
});
