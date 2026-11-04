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
    if (method === 'DOM.getFrameOwner') result = { backendNodeId: 9 };
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
  function target(id, url = ordinary, child) {
    const frame = {
      id,
      url,
      securityOrigin: URL.canParse(url) ? new URL(url).origin : url,
    };
    const tree = child
      ? {
          frame,
          childFrames: [
            {
              frame: {
                id: `${id}-ext`,
                parentId: id,
                url: child,
                securityOrigin: new URL(child).origin,
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
            frameId: `${id}-ext`,
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
    if (child) {
      targets.set(`${id}-ext-target`, {
        info: { targetId: `${id}-ext-target`, type: 'iframe', url: child, parentId: id },
        tree: {
          frame: {
            id: `${id}-ext`,
            parentId: id,
            url: child,
            securityOrigin: new URL(child).origin,
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
        securityOrigin: new URL(foreign).origin,
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
