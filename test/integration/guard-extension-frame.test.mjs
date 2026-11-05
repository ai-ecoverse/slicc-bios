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
const MARKER = { version: 1, kind: 'extensionFrame' };
const MARKER_HIDDEN = { ...MARKER, hidden: true, focused: false };
const MARKER_SHOWN = { ...MARKER, hidden: false, focused: true };
const MARKER_FOCUSED = { ...MARKER, hidden: true, focused: true };
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
      return emit({ id, ...(sessionId ? { sessionId } : {}), ...payload });
    }
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    if (method === 'Target.getTargetInfo') result = { targetInfo: target.info };
    if (method === 'Target.getTargets')
      result = { targetInfos: [...targets.values()].map((entry) => entry.info) };
    if (method === 'Target.attachToTarget') {
      if (target?.info.url?.startsWith('chrome-extension:')) {
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
    if (method === 'DOM.getFrameOwner') {
      result = {
        backendNodeId: 9,
        ...(target?.ownerMarker ? { sliccExtensionFrame: target.ownerMarker } : {}),
      };
    }
    if (method === 'DOM.resolveNode')
      result = { object: { objectId: 'ext-frame-object', type: 'object' } };
    if (method === 'Runtime.callFunctionOn')
      result = answers.get('Runtime.callFunctionOn')?.(message)?.result ?? {
        result: { type: 'boolean', value: false },
      };
    if (method === 'Runtime.releaseObjectGroup') result = {};
    if (method === 'Page.enable' || method === 'DOM.disable' || method === 'Target.setAutoAttach')
      result = {};
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  function request(method, params = {}, sessionId, id = ++next) {
    const answer = new Promise((resolve) => pending.set(key(id, sessionId), resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  }
  function target(id, url = ordinary, options = {}) {
    const {
      marker,
      childUrl = 'about:blank',
      src,
      childOrigin,
      contentDocument,
      nodeName = 'IFRAME',
      attributes,
      extraChild,
    } = typeof options === 'string'
      ? { childUrl: options, src: options, childOrigin: extensionOrigin(options) }
      : options;
    const frame = {
      id,
      url,
      securityOrigin: URL.canParse(url) ? new URL(url).origin : url,
      loaderId: `${id}-loader`,
    };
    const childId = `${id}-ext`;
    const hasChild =
      marker !== undefined ||
      typeof options === 'string' ||
      options.child ||
      options.childUrl !== undefined ||
      options.src !== undefined;
    const tree = hasChild
      ? {
          frame,
          childFrames: [
            {
              frame: {
                id: childId,
                parentId: id,
                url: childUrl,
                securityOrigin:
                  childOrigin ??
                  (childUrl && childUrl !== 'about:blank' && URL.canParse(childUrl)
                    ? extensionOrigin(childUrl)
                    : '://'),
              },
            },
            ...(extraChild
              ? [
                  {
                    frame: {
                      id: `${id}-nested`,
                      parentId: childId,
                      url: extraChild,
                      securityOrigin: extensionOrigin(extraChild),
                    },
                  },
                ]
              : []),
          ],
        }
      : { frame };
    const owner = hasChild
      ? {
          nodeId: 2,
          nodeName,
          frameId: childId,
          attributes:
            attributes ??
            (src !== undefined ? ['src', src] : childUrl ? ['src', childUrl] : ['src', '']),
          ...(marker !== undefined ? { sliccExtensionFrame: marker } : {}),
          ...(contentDocument ? { contentDocument } : {}),
        }
      : undefined;
    const owners = owner ? [owner] : [];
    const entry = {
      info: { targetId: id, type: 'page', url },
      tree,
      owners,
      ownerMarker: marker,
    };
    targets.set(id, entry);
    return entry;
  }
  async function attach(id) {
    const answer = await request('Target.attachToTarget', { targetId: id, flatten: true });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
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
  };
}

test('a marked foreign extension frame does not lock an ordinary tab', async (t) => {
  const wire = protocol(t);
  wire.target('foreign-open', ordinary, { marker: MARKER });
  const session = await wire.attach('foreign-open');
  const read = await wire.request(
    'Runtime.evaluate',
    { expression: 'document.title', returnByValue: true },
    session
  );
  assert.equal(read.error, undefined, JSON.stringify(read));
  assert.equal(read.result.result.value, ordinary);
});

async function assertPageLocked(wire, targetId) {
  const attached = await wire.request('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  if (attached.error) {
    assert.equal(attached.error.message, PROTECTED);
    return;
  }
  await flush();
  const shot = await wire.request('Page.captureScreenshot', {}, attached.result.sessionId);
  assert.equal(shot.error?.message, PROTECTED);
}

test('without a marker an empty remote frame still locks', async (t) => {
  const wire = protocol(t);
  wire.target('no-marker', ordinary, { child: true, childUrl: '' });
  await assertPageLocked(wire, 'no-marker');
});

test('marker version 2 is ignored and the tab stays locked', async (t) => {
  const wire = protocol(t);
  wire.target('bad-version', ordinary, {
    marker: { version: 2, kind: 'extensionFrame', hidden: true, focused: false },
    childUrl: '',
  });
  await assertPageLocked(wire, 'bad-version');
});

test('a forged DOM attribute does not unlock the tab', async (t) => {
  const wire = protocol(t);
  wire.target('forged-attr', ordinary, {
    child: true,
    childUrl: '',
    attributes: ['data-slicc-extension-frame', '1', 'src', ''],
  });
  await assertPageLocked(wire, 'forged-attr');
});

test('a marker on a non-IFRAME node is ignored', async (t) => {
  const wire = protocol(t);
  wire.target('non-iframe', ordinary, {
    marker: MARKER_HIDDEN,
    nodeName: 'DIV',
    childUrl: '',
  });
  await assertPageLocked(wire, 'non-iframe');
});

test("seven's own extension frame without a marker still locks the tab", async (t) => {
  const wire = protocol(t, [
    'https://protected.invalid',
    'chrome-extension://ownextensionid000000000000000000',
  ]);
  wire.target('own-lock', ordinary, { child: true, childUrl: '', src: ownExt });
  await assertPageLocked(wire, 'own-lock');
});

test('seven, vault and another protected scheme still lock', async (t) => {
  for (const [id, url] of [
    ['seven-lock', seven],
    ['vault-lock', vault],
    ['chrome-lock', chrome],
  ]) {
    const wire = protocol(t);
    wire.target(id, ordinary, { childUrl: url, src: url });
    await assertPageLocked(wire, id);
  }
});

test('a protected frame nested under a marked extension owner still locks', async (t) => {
  const wire = protocol(t);
  wire.target('nested-protected', ordinary, { marker: MARKER, extraChild: seven });
  await assertPageLocked(wire, 'nested-protected');
});

test('marker with absent fields admits whenShown after a live hidden check', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('absent-fields', ordinary, { marker: MARKER });
  const session = await wire.attach('absent-fields');
  for (const method of whenShown.filter((name) => name.startsWith('Input.'))) {
    const answer = await wire.request(method, {}, session);
    assert.equal(answer.error, undefined, method);
  }
});

test('marker with absent fields refuses whenShown when the live check says shown', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: true } },
  }));
  wire.target('absent-shown', ordinary, { marker: MARKER });
  const session = await wire.attach('absent-shown');
  const answer = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'a' },
    session
  );
  assert.equal(answer.error?.message, SHOWN_REFUSAL);
});

test('marker hidden:true focused:false admits whenShown when live agrees', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('hidden-in', ordinary, { marker: MARKER_HIDDEN });
  const session = await wire.attach('hidden-in');
  const answer = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'a' },
    session
  );
  assert.equal(answer.error, undefined);
});

test('marker hidden:true focused:false refuses when live check disagrees', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: true } },
  }));
  wire.target('disagree', ordinary, { marker: MARKER_HIDDEN });
  const session = await wire.attach('disagree');
  const answer = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(answer.error?.message, SHOWN_REFUSAL);
});

test('marker focused or shown refuses whenShown with shownRefusal', async (t) => {
  for (const [id, marker] of [
    ['shown-mark', MARKER_SHOWN],
    ['focus-mark', MARKER_FOCUSED],
  ]) {
    const wire = protocol(t);
    wire.answers.set('Runtime.callFunctionOn', () => ({
      result: { result: { type: 'boolean', value: false } },
    }));
    wire.target(id, ordinary, { marker });
    const session = await wire.attach(id);
    const answer = await wire.request('Page.captureScreenshot', {}, session);
    assert.equal(answer.error?.message, SHOWN_REFUSAL, id);
  }
});

test('a visibility check error or timeout refuses with shownRefusal', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    error: { code: -32000, message: 'probe failed' },
  }));
  wire.target('check-err', ordinary, { marker: MARKER });
  const session = await wire.attach('check-err');
  const answer = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(answer.error?.message, SHOWN_REFUSAL);
});

test('whilePresent captures refuse with presentRefusal', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('present-in', ordinary, { marker: MARKER });
  const session = await wire.attach('present-in');
  for (const method of whilePresent) {
    const answer = await wire.request(method, {}, session);
    assert.equal(answer.error?.message, PRESENT_REFUSAL, method);
  }
});

test('the marker never teaches the guard a URL', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('no-url', ordinary, { marker: MARKER_HIDDEN });
  const session = await wire.attach('no-url');
  const tree = await wire.request('Page.getFrameTree', {}, session);
  assert.equal(tree.error, undefined);
  assert.equal(JSON.stringify(tree.result).includes('chrome-extension://'), false);
  const evaluate = await wire.request(
    'Runtime.evaluate',
    { expression: '1', returnByValue: true },
    session
  );
  assert.equal(evaluate.error, undefined);
  assert.equal(
    JSON.stringify(wire.targets.get('no-url').owners).includes('chrome-extension'),
    false
  );
});

test('frameId commands on an embedded marked frame stay refused except getFrameOwner', async (t) => {
  const wire = protocol(t);
  wire.target('frame-ext-id', ordinary, { marker: MARKER });
  const session = await wire.attach('frame-ext-id');
  const refused = await wire.request(
    'Page.createIsolatedWorld',
    { frameId: 'frame-ext-id-ext', worldName: 'client' },
    session
  );
  assert.equal(refused.error?.message, PROTECTED);
  const owner = await wire.request('DOM.getFrameOwner', { frameId: 'frame-ext-id-ext' }, session);
  assert.equal(owner.error, undefined, JSON.stringify(owner));
  assert.equal(owner.result.backendNodeId, 9);
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

test('embedded foreign extension document requests do not cut the tab', async (t) => {
  const wire = protocol(t);
  wire.target('embed-doc', ordinary, { marker: MARKER, childUrl: foreign, src: foreign });
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
  wire.target('reuse-world', ordinary, { marker: MARKER });
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

test('DOM setChildNodes childNodeInserted and describeNode accept markers', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('dom-events', ordinary, { marker: MARKER });
  const session = await wire.attach('dom-events');
  wire.emit({
    method: 'DOM.setChildNodes',
    sessionId: session,
    params: {
      parentNodeId: 1,
      nodes: [
        {
          nodeId: 3,
          nodeName: 'IFRAME',
          frameId: 'dom-events-ext',
          attributes: ['src', ''],
          sliccExtensionFrame: MARKER_HIDDEN,
        },
      ],
    },
  });
  wire.emit({
    method: 'DOM.childNodeInserted',
    sessionId: session,
    params: {
      parentNodeId: 1,
      node: {
        nodeId: 4,
        nodeName: 'IFRAME',
        frameId: 'dom-events-ext',
        attributes: ['src', ''],
        sliccExtensionFrame: MARKER,
      },
    },
  });
  await flush();
  wire.answers.set('DOM.describeNode', () => ({
    result: {
      node: {
        nodeId: 2,
        nodeName: 'IFRAME',
        frameId: 'dom-events-ext',
        attributes: ['src', ''],
        sliccExtensionFrame: MARKER_HIDDEN,
      },
    },
  }));
  const described = await wire.request('DOM.describeNode', { nodeId: 2 }, session);
  assert.equal(described.error, undefined, JSON.stringify(described));
  const answer = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'a' },
    session
  );
  assert.equal(answer.error, undefined);
});

test('getFrameOwner marker shown during live check refuses whenShown', async (t) => {
  const wire = protocol(t);
  let ownerCalls = 0;
  wire.answers.set('DOM.getFrameOwner', () => {
    ownerCalls += 1;
    return {
      result: { backendNodeId: 9, sliccExtensionFrame: MARKER_SHOWN },
    };
  });
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('owner-shown', ordinary, { marker: MARKER_HIDDEN });
  const session = await wire.attach('owner-shown');
  const answer = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(answer.error?.message, SHOWN_REFUSAL);
  assert.ok(ownerCalls > 0);
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
  wire.target('stale-world', ordinary, { marker: MARKER });
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
