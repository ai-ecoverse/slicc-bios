import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { listen } = await import(
  pathToFileURL(`${process.env.SLICC_DIAGNOSTIC_EXTENSION}/cdp.js`).href
);
const protectedUrl = 'https://vault.sliccy.ai/';
const ordinary = 'https://ordinary.test/';
const tree = (url, unreachableUrl) => ({
  frameTree: {
    frame: {
      id: 'MAIN',
      loaderId: 'LOADER',
      url,
      securityOrigin: url.startsWith('chrome-error:') ? '://' : new URL(url).origin,
      ...(unreachableUrl ? { unreachableUrl } : {}),
    },
  },
});
const event = () => {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    fire: (...args) => Promise.all([...listeners].map((listener) => listener(...args))),
  };
};

async function fixture({ auth = false } = {}) {
  const received = [];
  const sent = [];
  let raw = ordinary;
  let current = tree(ordinary);
  let refuseTree = false;
  let paused;
  let blocked;
  const held = new Promise((resolve) => {
    paused = resolve;
  });
  const failed = new Promise((resolve) => {
    blocked = resolve;
  });
  const port = {
    name: 'slicc-fetch',
    sender: { id: 'ext', url: 'https://seven.sliccy.ai/' },
    onDisconnect: event(),
    disconnect() {},
    postMessage(message) {
      if (message.diagnostic) return;
      received.push(message);
      if (message.method === 'Fetch.requestPaused' || message.method === 'Fetch.authRequired')
        paused(message);
    },
  };
  const onEvent = event();
  const api = {
    tabs: {
      query: async () => [
        { id: 7, url: 'https://seven.sliccy.ai/', windowId: 1 },
        { id: 8, url: raw, windowId: 1 },
      ],
      get: async (id) => ({ id, url: id === 8 ? raw : 'https://seven.sliccy.ai/', windowId: 1 }),
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
    },
    windows: { onFocusChanged: event() },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, url: raw, errorOccurred: raw === protectedUrl }],
    },
    debugger: {
      onEvent,
      onDetach: event(),
      attach: async () => {},
      detach: async () => {},
      async sendCommand({ tabId }, method, params) {
        sent.push({ tabId, method, params });
        if (method === 'Page.getFrameTree') {
          if (refuseTree) throw new Error('renderer query blocked by paused navigation');
          return current;
        }
        if (method === 'Page.getNavigationHistory')
          return { currentIndex: 0, entries: [{ id: 1, url: raw }] };
        if (method === 'Runtime.enable')
          await onEvent.fire({ tabId }, 'Runtime.executionContextCreated', {
            context: {
              id: 9999,
              uniqueId: 'MAIN-CONTEXT',
              origin: ordinary,
              auxData: { frameId: 'MAIN', isDefault: true },
            },
          });
        if (method === 'Runtime.evaluate')
          return { result: { type: 'object', objectId: '123.9999.0' } };
        if (method === 'Fetch.failRequest' && params.requestId === 'BLOCKED') blocked();
        return {};
      },
    },
  };
  const connection = listen(port, 'ext', api);
  assert.ok(connection);
  let next = 0;
  const call = async (method, params = {}, sessionId) => {
    const id = ++next;
    assert.equal(
      connection.handle({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      true
    );
    await connection.settled();
    const answer = received.find((message) => message.id === id);
    assert.ok(answer, `${method} answered`);
    return answer;
  };
  const first = await call('Target.attachToTarget', { targetId: '8', flatten: true });
  assert.ok(first.result?.sessionId, 'ordinary target attached');
  const session = first.result.sessionId;
  const second = await call('Target.attachToTarget', { targetId: '8', flatten: true });
  assert.ok(second.result?.sessionId, 'second ordinary session attached');
  await call(
    'Fetch.enable',
    {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
      handleAuthRequests: auth,
    },
    session
  );
  await onEvent.fire({ tabId: 8 }, 'Fetch.requestPaused', {
    requestId: 'BLOCKED',
    frameId: 'MAIN',
    resourceType: 'Document',
    request: { url: protectedUrl, method: 'GET' },
  });
  await failed;
  raw = protectedUrl;
  current = tree('chrome-error://chromewebdata/', protectedUrl);
  await onEvent.fire({ tabId: 8 }, 'Page.frameNavigated', { frame: current.frameTree.frame });
  const method = auth ? 'Fetch.authRequired' : 'Fetch.requestPaused';
  await onEvent.fire({ tabId: 8 }, method, {
    requestId: 'HELD',
    frameId: 'MAIN',
    resourceType: 'Document',
    request: { url: ordinary, method: 'GET' },
    ...(auth
      ? {
          authChallenge: { source: 'Server', origin: ordinary, scheme: 'basic', realm: 'ordinary' },
        }
      : {}),
  });
  const offered = await held;
  assert.equal(offered.sessionId, session, 'the extension offers the request to its owner');
  refuseTree = true;
  sent.length = 0;
  return { connection, call, sent, session, other: second.result.sessionId };
}

test('diagnostic held pause: only the plain owner continuation avoids the blocked tree', async () => {
  const rig = await fixture();
  try {
    const answer = await rig.call('Fetch.continueRequest', { requestId: 'HELD' }, rig.session);
    assert.equal(answer.error, undefined);
    assert.equal(rig.sent.filter(({ method }) => method === 'Page.getFrameTree').length, 0);
    assert.equal(rig.sent.filter(({ method }) => method === 'Fetch.continueRequest').length, 1);
  } finally {
    rig.connection.close();
  }
});

const rejected = [
  ['url override', 'Fetch.continueRequest', { url: ordinary }],
  ['method override', 'Fetch.continueRequest', { method: 'POST' }],
  ['headers override', 'Fetch.continueRequest', { headers: [] }],
  ['postData override', 'Fetch.continueRequest', { postData: '' }],
  ['interceptResponse override', 'Fetch.continueRequest', { interceptResponse: false }],
  ['fulfillRequest', 'Fetch.fulfillRequest', { responseCode: 200, body: '' }],
  ['failRequest', 'Fetch.failRequest', { errorReason: 'BlockedByClient' }],
  ['body read', 'Fetch.getResponseBody', {}],
  ['auth reply', 'Fetch.continueWithAuth', { authChallengeResponse: { response: 'Default' } }],
  ['wrong session', 'Fetch.continueRequest', {}, 'other'],
  ['unknown request', 'Fetch.continueRequest', { requestId: 'UNKNOWN' }],
  ['auth hold', 'Fetch.continueRequest', {}, 'owner', true],
];

for (const [name, method, params, owner = 'owner', auth = false] of rejected) {
  test(`diagnostic held pause: ${name} retains the full check and is refused`, async () => {
    const rig = await fixture({ auth });
    try {
      const answer = await rig.call(
        method,
        { requestId: 'HELD', ...params },
        owner === 'other' ? rig.other : rig.session
      );
      assert.ok(answer.error);
      assert.ok(
        rig.sent.some(({ method }) => method === 'Page.getFrameTree'),
        'the normal error-tree admission was checked'
      );
      assert.equal(
        rig.sent.filter((command) => command.method === method).length,
        0,
        'no answer or read reached Chrome'
      );
    } finally {
      rig.connection.close();
    }
  });
}
