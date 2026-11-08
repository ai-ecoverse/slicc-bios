import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionConnection } from '../../src/seed/cdp.js';
import { guardProtected, NO_AUTO_ATTACH, TAB_ONLY } from '../../src/seed/guard.js';

const ORDINARY = 'https://ordinary.invalid/page';
const GUARD_IDS = 2 ** 30;

function extension() {
  const listeners = new Set();
  const sent = [];
  let sessions = 0;
  const frame = {
    id: 'frame-ordinary',
    loaderId: 'loader',
    url: ORDINARY,
    securityOrigin: 'https://ordinary.invalid',
  };
  const answers = {
    'Target.setAutoAttach': () => {
      throw new Error(NO_AUTO_ATTACH);
    },
    'Target.attachToTarget': () => {
      sessions += 1;
      return { sessionId: `ordinary~${sessions}` };
    },
    'Target.getTargetInfo': ({ targetId }) => ({
      targetInfo: { targetId: targetId ?? 'ordinary', type: 'page', url: ORDINARY, attached: true },
    }),
    'Target.getTargets': () => ({
      targetInfos: [{ targetId: 'ordinary', type: 'page', url: ORDINARY, title: 'ordinary' }],
    }),
    'Browser.getVersion': () => ({ product: 'Chrome/157', protocolVersion: '1.3' }),
    'Page.getFrameTree': () => ({ frameTree: { frame } }),
    'Page.getNavigationHistory': () => ({
      currentIndex: 0,
      entries: [{ id: 0, url: ORDINARY, userTypedURL: ORDINARY, title: '' }],
    }),
    'DOM.getDocument': () => ({ root: { nodeId: 1, nodeName: '#document', children: [] } }),
    'DOMSnapshot.captureSnapshot': () => ({ documents: [], strings: [] }),
    'Runtime.evaluate': () => ({ result: { value: ORDINARY } }),
  };
  return {
    sent,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params, sessionId) {
      sent.push({ method, params, sessionId });
      await Promise.resolve();
      return answers[method]?.(params ?? {}) ?? {};
    },
  };
}

function connect() {
  const cdp = extension();
  const transport = extensionConnection(cdp);
  const seen = [];
  const autoAttaches = new Set();
  const spied = {
    send: (text) => {
      const command = JSON.parse(text);
      if (command.method === 'Target.setAutoAttach' && command.id >= GUARD_IDS)
        autoAttaches.add(command.id);
      return transport.send(text);
    },
    close: () => transport.close(),
    set onmessage(fn) {
      transport.onmessage = (text) => {
        seen.push(JSON.parse(text));
        fn?.(text);
      };
    },
    set onclose(fn) {
      transport.onclose = fn;
    },
  };
  const guarded = guardProtected(spied, ['https://seven.invalid'], new Map(), {
    kind: 'extension',
    version: '7.10.0',
  });
  const got = [];
  guarded.onmessage = (text) => got.push(JSON.parse(text));
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    id += 1;
    const mine = id;
    guarded.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (let n = 0; n < 600 && !got.some((message) => message.id === mine); n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const answer = got.find((message) => message.id === mine);
    assert.ok(answer, `${method} got an answer through the guard`);
    return answer;
  };
  return { cdp, seen, autoAttaches, got, send };
}

test('on the extension route a page-session auto-attach the extension refuses stays refused, and the guard still sees its own refusal', {
  timeout: 30000,
}, async () => {
  const { cdp, seen, autoAttaches, send } = connect();
  const attached = await send('Target.attachToTarget', { targetId: 'ordinary', flatten: true });
  const session = attached.result?.sessionId;
  assert.ok(session, JSON.stringify(attached));
  const holder = await send(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe' }],
    },
    session
  );
  assert.equal(holder.error?.message, NO_AUTO_ATTACH);
  const forwarded = cdp.sent.filter(
    (call) => call.method === 'Target.setAutoAttach' && call.sessionId === session
  );
  assert.deepEqual(forwarded.at(-1).params.filter, [{ type: 'iframe' }]);
  const own = seen.filter((message) => autoAttaches.has(message.id));
  assert.ok(own.length > 0, 'the guard placed the page with its own auto-attach');
  assert.ok(
    own.every((message) => message.error?.message === NO_AUTO_ATTACH),
    JSON.stringify(own)
  );
  assert.deepEqual(
    (
      await send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        session
      )
    ).result,
    {}
  );
  assert.deepEqual(
    (await send('Target.setAutoAttach', { autoAttach: true, flatten: true, filter: [{}] }, session))
      .result,
    {}
  );
});

test('on the extension route stock auto-attach is synthesized without a real browser-wide auto-attach, and getVersion keeps its route', {
  timeout: 30000,
}, async () => {
  const { cdp, got, send } = connect();
  assert.deepEqual(
    (
      await send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'page', exclude: true }, {}],
      })
    ).result,
    {}
  );
  let tab;
  for (let n = 0; n < 400 && !tab; n++) {
    tab = got.find(
      (message) =>
        message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'tab'
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(tab, 'a synthetic tab target');
  const tabSession = tab.params.sessionId;
  assert.equal(
    (await send('Runtime.evaluate', { expression: '1' }, tabSession)).error?.message,
    TAB_ONLY
  );
  assert.deepEqual(
    (
      await send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{}] },
        tabSession
      )
    ).result,
    {}
  );
  assert.ok(
    !cdp.sent.some(
      (call) =>
        call.method === 'Target.setAutoAttach' &&
        (call.sessionId === undefined || call.sessionId === tabSession)
    ),
    'no browser-wide or tab-session auto-attach reached the extension'
  );
  const version = await send('Browser.getVersion');
  assert.equal(version.result?.slicc?.route, 'extension');
});
