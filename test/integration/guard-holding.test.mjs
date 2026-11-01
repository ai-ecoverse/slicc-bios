import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected, PROTECTED } from '../../src/seed/guard.js';

const OWN = 'https://seven.sliccy.ai';
const PAGE = 'https://site.test/';
const TARGET = 'tab-1';

const info = () => ({
  targetId: TARGET,
  type: 'page',
  url: PAGE,
  title: 'site',
  attached: true,
  canAccessOpener: false,
  browserContextId: 'default',
});

const origined = (frame) => ({
  ...frame,
  loaderId: 'l2',
  securityOrigin: /^https?:/.test(frame.url) ? new URL(frame.url).origin : 'null',
});

function port({ holds = true, frames = [] }) {
  const state = { frames, trees: 0, nextSession: 0 };
  const emit = (message) => queueMicrotask(() => connection.onmessage?.(JSON.stringify(message)));
  const tree = () => ({
    frameTree: {
      frame: { id: TARGET, url: PAGE, securityOrigin: new URL(PAGE).origin, loaderId: 'l1' },
      childFrames: state.frames
        .filter((frame) => frame.parentId === undefined || frame.parentId === TARGET)
        .map(({ closed, ...frame }) => ({ frame: { parentId: TARGET, ...origined(frame) } })),
    },
  });
  const documentNode = () => ({
    root: {
      nodeId: 1,
      nodeName: '#document',
      documentURL: PAGE,
      children: state.frames
        .filter((frame) => !frame.closed)
        .map((frame, at) => ({
          nodeId: at + 2,
          nodeName: 'IFRAME',
          frameId: frame.id,
          attributes: ['src', frame.url],
        })),
    },
  });
  const answers = {
    'Target.getTargets': () => ({ targetInfos: [info()] }),
    'Target.getTargetInfo': () => ({ targetInfo: info() }),
    'Target.attachToTarget': (params) => {
      const sessionId = `session-${++state.nextSession}`;
      emit({
        method: 'Target.attachedToTarget',
        params: { sessionId, targetInfo: info(), waitingForDebugger: false },
      });
      return { sessionId };
    },
    'Fetch.enable': () => (holds ? { holdsDocuments: true } : {}),
    'Page.getFrameTree': () => {
      state.trees += 1;
      return tree();
    },
    'DOM.getDocument': documentNode,
    'Page.getNavigationHistory': () => ({
      currentIndex: 0,
      entries: [{ id: 0, url: PAGE, userTypedURL: PAGE, title: 'site', transitionType: 'link' }],
    }),
    'Runtime.evaluate': () => ({ result: { type: 'string', value: PAGE } }),
    'Page.captureScreenshot': () => ({ data: 'cGl4ZWxz' }),
    'Page.printToPDF': () => ({ data: 'cGRm' }),
  };
  const connection = {
    onmessage: null,
    onclose: null,
    state,
    close() {},
    send(text) {
      const { id, method, params, sessionId } = JSON.parse(text);
      const envelope = { id, ...(sessionId ? { sessionId } : {}) };
      if (method === 'Target.setAutoAttach' && sessionId) {
        return emit({
          ...envelope,
          error: {
            code: -32601,
            message: 'slicc: refused: Target.setAutoAttach is not supported: attach to each target',
          },
        });
      }
      if (method === 'Runtime.enable') {
        emit({
          sessionId,
          method: 'Runtime.executionContextCreated',
          params: {
            context: {
              id: 1,
              uniqueId: 'l1.1',
              origin: new URL(PAGE).origin,
              name: '',
              auxData: { isDefault: true, type: 'default', frameId: TARGET },
            },
          },
        });
      }
      emit({ ...envelope, result: answers[method]?.(params) ?? {} });
    },
  };
  return connection;
}

async function driven(options) {
  const crest = port(options);
  const guarded = guardProtected(crest, OWN);
  let next = 0;
  const waiting = new Map();
  guarded.onmessage = (text) => {
    const message = JSON.parse(text);
    waiting.get(message.id)?.(message);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      guarded.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const attached = await call('Target.attachToTarget', { targetId: TARGET, flatten: true });
  assert.equal(attached.error, undefined);
  return { crest, call, session: attached.result.sessionId };
}

const painted = async ({ call, session }) => ({
  shot: (await call('Page.captureScreenshot', {}, session)).error?.message ?? 'ok',
  pdf: (await call('Page.printToPDF', {}, session)).error?.message ?? 'ok',
  dom: (await call('DOM.getDocument', { depth: 0 }, session)).error?.message ?? 'ok',
});
const open = { shot: 'ok', pdf: 'ok', dom: 'ok' };
const locked = { shot: PROTECTED, pdf: PROTECTED, dom: PROTECTED };
const frame = (url, more = {}) => ({ id: `frame:${url}`, url, ...more });

test('a holding browser with no child frames paints', async () => {
  assert.deepEqual(await painted(await driven({})), open);
});

test('a holding browser paints past a known, unprotected frame, in the DOM or a closed root', async () => {
  const site = 'https://ads.example/';
  assert.deepEqual(await painted(await driven({ frames: [frame(site)] })), open);
  assert.deepEqual(await painted(await driven({ frames: [frame(site, { closed: true })] })), open);
});

test('a browser that doesn’t attest holdsDocuments stays locked by the same frame', async () => {
  const frames = [frame('https://ads.example/')];
  assert.deepEqual(await painted(await driven({ holds: false, frames })), locked);
});

test('without the attestation an owner-less frame is read as it always was', async () => {
  const frames = [frame('https://ads.example/', { closed: true })];
  assert.deepEqual(await painted(await driven({ holds: false, frames })), open);
});

for (const url of [
  'about:blank',
  'about:srcdoc',
  'blob:https://site.test/1f0e',
  'data:text/html,<h1>x</h1>',
  'javascript:0',
  '',
]) {
  test(`a frame at ${url || 'no address'} keeps the lock, because its origin isn't known`, async () => {
    assert.deepEqual(await painted(await driven({ frames: [frame(url)] })), locked);
    assert.deepEqual(
      await painted(await driven({ frames: [frame(url, { closed: true })] })),
      locked
    );
  });
}

test('a frame that moves after the last read can’t slip through: each command reads the tree again', async () => {
  const site = frame('https://ads.example/');
  const page = await driven({ frames: [site] });
  assert.deepEqual(await painted(page), open);
  const before = page.crest.state.trees;
  site.url = 'about:srcdoc';
  assert.equal(
    (await page.call('Page.captureScreenshot', {}, page.session)).error?.message,
    PROTECTED
  );
  assert.equal((await page.call('Page.printToPDF', {}, page.session)).error?.message, PROTECTED);
  assert.ok(page.crest.state.trees >= before + 2);
  site.url = 'https://ads.example/';
  assert.deepEqual(await painted(page), open);
});

test('a frame that appears after the last read is checked too', async () => {
  const page = await driven({});
  assert.deepEqual(await painted(page), open);
  page.crest.state.frames.push(frame('about:blank'));
  assert.deepEqual(await painted(page), locked);
});

test('a tree that can’t be read again refuses the command', async () => {
  const page = await driven({ frames: [frame('https://ads.example/')] });
  const send = page.crest.send.bind(page.crest);
  page.crest.send = (text) => {
    const { id, method, sessionId } = JSON.parse(text);
    if (method !== 'Page.getFrameTree') return send(text);
    queueMicrotask(() =>
      page.crest.onmessage(
        JSON.stringify({ id, sessionId, error: { code: -32000, message: 'no' } })
      )
    );
  };
  const { error } = await page.call('Page.captureScreenshot', {}, page.session);
  assert.ok(error, 'refused');
});
