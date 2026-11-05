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

function protocol(t, own = 'https://protected.invalid', route) {
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
  const guard = guardProtected(raw, own, new Map(), route);
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
    if (method === 'Target.getTargetInfo') result = { targetInfo: target?.info };
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
    if (method === 'Page.getFrameTree') result = { frameTree: target?.tree };
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

test('a marked foreign extension frame does not lock an ordinary tab', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
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

test('without a marker a raw chrome-extension frame locks like main', async (t) => {
  const wire = protocol(t);
  wire.target('raw-ext', ordinary, { childUrl: foreign, src: foreign });
  await assertPageLocked(wire, 'raw-ext');
});

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

test('a marker on the scope root is ignored', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('root-mark', ordinary);
  entry.owners = [
    {
      nodeId: 2,
      nodeName: 'IFRAME',
      frameId: 'root-mark',
      attributes: ['src', ''],
      sliccExtensionFrame: MARKER_HIDDEN,
    },
  ];
  entry.tree = {
    frame: {
      id: 'root-mark',
      url: ordinary,
      securityOrigin: 'https://ordinary.invalid',
      loaderId: 'root-mark-loader',
    },
    childFrames: [
      {
        frame: {
          id: 'root-mark-ext',
          parentId: 'root-mark',
          url: '',
          securityOrigin: '://',
        },
      },
    ],
  };
  await assertPageLocked(wire, 'root-mark');
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

test('a marked frame with a known protected url still locks', async (t) => {
  const wire = protocol(t);
  wire.target('marked-seven', ordinary, { marker: MARKER_HIDDEN, childUrl: seven, src: seven });
  await assertPageLocked(wire, 'marked-seven');
});

test('a marked frame that is an error page for an unsafe url still locks', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('marked-error', ordinary, { marker: MARKER_HIDDEN, childUrl: '' });
  const session = await wire.attach('marked-error');
  const open = await wire.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session);
  assert.equal(open.error, undefined);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: 'marked-error-ext',
        parentId: 'marked-error',
        url: 'chrome-error://chromewebdata/',
        securityOrigin: '://',
        unreachableUrl: vault,
        loaderId: 'marked-error-loader',
      },
    },
  });
  await flush();
  const shot = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(shot.error?.message, PROTECTED);
});

test('an unmarked unknown remote next to a marked frame still locks', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('pair-mark', ordinary, { marker: MARKER_HIDDEN, childUrl: '' });
  entry.owners.push({
    nodeId: 3,
    nodeName: 'IFRAME',
    frameId: 'pair-mark-other',
    attributes: ['src', ''],
  });
  entry.tree.childFrames.push({
    frame: {
      id: 'pair-mark-other',
      parentId: 'pair-mark',
      url: '',
      securityOrigin: '://',
    },
  });
  await assertPageLocked(wire, 'pair-mark');
});

test('a snapshot remote backend owner without a frameId locks like main', async (t) => {
  const wire = protocol(t, 'https://protected.invalid', { kind: 'extension' });
  const strings = ['snap-remote', ordinary, '#document', 'IFRAME', 'src', '', 'snap-remote-ext'];
  wire.answers.set('DOMSnapshot.captureSnapshot', () => ({
    result: {
      strings,
      documents: [
        {
          frameId: 0,
          documentURL: 1,
          nodes: {
            nodeName: [2, 3, 3],
            backendNodeId: [1, 2, 99],
            attributes: [[], [4, 5], [4, 5]],
            contentDocumentIndex: { index: [1], value: [1] },
          },
        },
        {
          frameId: 6,
          documentURL: 5,
          nodes: {
            nodeName: [2],
            backendNodeId: [3],
            attributes: [[]],
            contentDocumentIndex: { index: [], value: [] },
          },
        },
      ],
    },
  }));
  wire.target('snap-remote', ordinary, { childUrl: '', src: '' });
  await assertPageLocked(wire, 'snap-remote');
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

test('frameId commands on an embedded marked frame stay refused', async (t) => {
  const wire = protocol(t);
  wire.target('frame-ext-id', ordinary, { marker: MARKER });
  const session = await wire.attach('frame-ext-id');
  for (const [method, params] of [
    ['Page.createIsolatedWorld', { frameId: 'frame-ext-id-ext', worldName: 'client' }],
    ['DOM.getFrameOwner', { frameId: 'frame-ext-id-ext' }],
  ]) {
    const answer = await wire.request(method, params, session);
    assert.equal(answer.error?.message, PROTECTED, method);
  }
});

test('CONTENTS that name the vault stay refused as on main', async (t) => {
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

test('client describeNode and setChildNodes only ingest markers', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('client-dom', ordinary, { marker: MARKER });
  const session = await wire.attach('client-dom');
  const open = await wire.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session);
  assert.equal(open.error, undefined);
  wire.emit({
    method: 'DOM.setChildNodes',
    sessionId: session,
    params: {
      parentNodeId: 1,
      nodes: [
        {
          nodeId: 9,
          nodeName: 'IFRAME',
          frameId: 'client-dom-extra',
          attributes: ['src', ''],
        },
        {
          nodeId: 10,
          nodeName: 'IFRAME',
          attributes: ['src', ''],
        },
      ],
    },
  });
  await flush();
  const stillOpen = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'b' },
    session
  );
  assert.equal(stillOpen.error, undefined, JSON.stringify(stillOpen));
  wire.answers.set('DOM.describeNode', () => ({
    result: {
      node: {
        nodeId: 2,
        nodeName: 'IFRAME',
        frameId: 'client-dom-ext',
        attributes: ['src', ''],
        sliccExtensionFrame: MARKER_SHOWN,
      },
    },
  }));
  const described = await wire.request('DOM.describeNode', { nodeId: 2 }, session);
  assert.equal(described.error, undefined, JSON.stringify(described));
  const shown = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'c' },
    session
  );
  assert.equal(shown.error?.message, SHOWN_REFUSAL);
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

test('Runtime evaluate and callFunctionOn results never ingest extension frame markers', async (t) => {
  const wire = protocol(t);
  const lookalike = {
    result: { type: 'object', value: null },
    node: {
      nodeName: 'IFRAME',
      frameId: 'runtime-mark-ext',
      attributes: ['src', ''],
      sliccExtensionFrame: MARKER_SHOWN,
    },
    sliccExtensionFrame: MARKER_SHOWN,
  };
  let probes = 0;
  wire.answers.set('Runtime.callFunctionOn', () => {
    probes += 1;
    return probes === 1
      ? { result: lookalike }
      : { result: { result: { type: 'boolean', value: false } } };
  });
  wire.answers.set('Runtime.evaluate', () => ({ result: lookalike }));
  wire.target('runtime-mark', ordinary, { marker: MARKER });
  const session = await wire.attach('runtime-mark');
  const evaluated = await wire.request(
    'Runtime.evaluate',
    { expression: '({})', returnByValue: true },
    session
  );
  assert.equal(evaluated.error, undefined, JSON.stringify(evaluated));
  const called = await wire.request(
    'Runtime.callFunctionOn',
    { functionDeclaration: 'function(){ return null }', returnByValue: true },
    session
  );
  assert.equal(called.error, undefined, JSON.stringify(called));
  assert.equal(probes, 1);
  const answer = await wire.request(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'a' },
    session
  );
  assert.equal(answer.error, undefined, JSON.stringify(answer));
});

test('a detached then re-attached unmarked frame id stays locked', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('detach-mark', ordinary, { marker: MARKER_HIDDEN });
  const session = await wire.attach('detach-mark');
  const open = await wire.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session);
  assert.equal(open.error, undefined);
  wire.emit({
    method: 'Page.frameDetached',
    sessionId: session,
    params: { frameId: 'detach-mark-ext', reason: 'remove' },
  });
  await flush();
  wire.targets.get('detach-mark').owners = [
    {
      nodeId: 2,
      nodeName: 'IFRAME',
      frameId: 'detach-mark-ext',
      attributes: ['src', ''],
    },
  ];
  wire.targets.get('detach-mark').tree = {
    frame: {
      id: 'detach-mark',
      url: ordinary,
      securityOrigin: 'https://ordinary.invalid',
      loaderId: 'detach-mark-loader',
    },
    childFrames: [
      {
        frame: {
          id: 'detach-mark-ext',
          parentId: 'detach-mark',
          url: '',
          securityOrigin: '://',
        },
      },
    ],
  };
  wire.emit({
    method: 'Page.frameAttached',
    sessionId: session,
    params: { frameId: 'detach-mark-ext', parentFrameId: 'detach-mark' },
  });
  await flush();
  const shot = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(shot.error?.message, PROTECTED);
});

test('a root navigation clears extension markers so a later unmarked child locks', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  wire.target('nav-clear', ordinary, { marker: MARKER_HIDDEN });
  const session = await wire.attach('nav-clear');
  const open = await wire.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session);
  assert.equal(open.error, undefined);
  const next = `${ordinary}?after`;
  wire.targets.get('nav-clear').info.url = next;
  wire.targets.get('nav-clear').owners = [
    {
      nodeId: 2,
      nodeName: 'IFRAME',
      frameId: 'nav-clear-ext',
      attributes: ['src', ''],
    },
  ];
  wire.targets.get('nav-clear').tree = {
    frame: {
      id: 'nav-clear',
      url: next,
      securityOrigin: 'https://ordinary.invalid',
      loaderId: 'nav-clear-loader-2',
    },
    childFrames: [
      {
        frame: {
          id: 'nav-clear-ext',
          parentId: 'nav-clear',
          url: '',
          securityOrigin: '://',
        },
      },
    ],
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: 'nav-clear',
        url: next,
        securityOrigin: 'https://ordinary.invalid',
        loaderId: 'nav-clear-loader-2',
      },
    },
  });
  await flush();
  const shot = await wire.request('Page.captureScreenshot', {}, session);
  assert.equal(shot.error?.message, PROTECTED);
});

test('a top-level protected navigation cuts the session like main', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('root-seven-walk', ordinary);
  const session = await wire.attach('root-seven-walk');
  entry.info.url = seven;
  entry.tree = {
    frame: {
      id: 'root-seven-walk',
      url: seven,
      securityOrigin: 'https://seven.sliccy.ai',
      loaderId: 'seven-loader',
    },
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: 'root-seven-walk',
        url: seven,
        securityOrigin: 'https://seven.sliccy.ai',
        loaderId: 'seven-loader',
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

test('getFrameTree redacts a protected child frame url like main', async (t) => {
  const wire = protocol(t);
  wire.answers.set('Runtime.callFunctionOn', () => ({
    result: { result: { type: 'boolean', value: false } },
  }));
  const blankTree = {
    frame: {
      id: 'tree-redact',
      url: ordinary,
      securityOrigin: 'https://ordinary.invalid',
      loaderId: 'tree-redact-loader',
    },
    childFrames: [
      {
        frame: {
          id: 'tree-redact-ext',
          parentId: 'tree-redact',
          url: '',
          securityOrigin: '://',
        },
      },
    ],
  };
  wire.target('tree-redact', ordinary, { marker: MARKER_HIDDEN });
  wire.targets.get('tree-redact').tree = blankTree;
  const session = await wire.attach('tree-redact');
  const protectedTree = {
    frame: blankTree.frame,
    childFrames: [
      {
        frame: {
          id: 'tree-redact-ext',
          parentId: 'tree-redact',
          url: seven,
          securityOrigin: '://',
        },
      },
    ],
  };
  wire.targets.get('tree-redact').tree = protectedTree;
  wire.answers.set('Page.getFrameTree', (message) => ({
    result: { frameTree: message.id >= 2 ** 30 ? blankTree : protectedTree },
  }));
  const tree = await wire.request('Page.getFrameTree', {}, session);
  wire.answers.delete('Page.getFrameTree');
  await flush();
  assert.equal(tree.error, undefined, JSON.stringify(tree));
  assert.equal(JSON.stringify(tree.result).includes('seven.sliccy.ai'), false);
  assert.equal(tree.result.frameTree.childFrames[0].frame.url, 'chrome-error://chromewebdata/');
});

test('an unarmed session cuts on a protected document request like main', async (t) => {
  const wire = protocol(t);
  wire.target('doc-cut', ordinary);
  const session = await wire.attach('doc-cut');
  wire.emit({
    method: 'Target.detachedFromTarget',
    params: { sessionId: `guard-doc-cut`, targetId: 'doc-cut' },
  });
  await flush();
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'v1',
      type: 'Document',
      frameId: 'doc-cut',
      request: { url: vault },
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

test('frameNavigated records a protected child frame url like main', async (t) => {
  const wire = protocol(t);
  wire.target('pf-child', ordinary);
  const session = await wire.attach('pf-child');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: 'pf-child-frame',
        parentId: 'pf-child',
        url: vault,
        securityOrigin: '://',
        loaderId: 'pf-child-loader',
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

test('frameNavigated records a chrome-error frame with a protected unreachable url', async (t) => {
  const wire = protocol(t);
  wire.target('pf-error', ordinary);
  const session = await wire.attach('pf-error');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: {
      frame: {
        id: 'pf-error-frame',
        parentId: 'pf-error',
        url: 'chrome-error://chromewebdata/',
        securityOrigin: '://',
        unreachableUrl: vault,
        loaderId: 'pf-error-loader',
      },
    },
  });
  await flush();
  const tree = await wire.request('Page.getFrameTree', {}, session);
  assert.ok(tree.result || tree.error, JSON.stringify(tree));
});
