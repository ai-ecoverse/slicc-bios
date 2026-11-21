import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const bounce = 'https://ordinary.invalid/redirect';
const origin = 'https://seven.sliccy.ai';
const secret = `${origin}/doc?code=redirect-secret-marker&path=/private`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.60.0' }],
  ['extension', { kind: 'extension', version: '7.12.0' }],
];

const redirectHeaders = (to) => ({
  Location: to,
  Refresh: `0;url=${to}`,
  Link: `<${to}>; rel=preconnect`,
});

const headersText = (to) =>
  [
    'HTTP/1.1 302 Found',
    `Location: ${to}`,
    `Refresh: 0;url=${to}`,
    `Link: <${to}>; rel=preconnect`,
    '',
    '',
  ].join('\r\n');

function protocol(t, route) {
  const targets = new Map();
  const sessions = new Map();
  const delivered = [];
  const pending = new Map();
  let next = 0;
  const raw = {
    send(text) {
      const message = JSON.parse(text);
      queueMicrotask(() => respond(message));
    },
    close() {},
  };
  const guard = guardProtected(raw, origin, new Map(), route);
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
    const targetId = params.targetId ?? sessions.get(sessionId);
    const target = targets.get(targetId);
    let result = {};
    if (method === 'Target.attachToTarget') {
      const attached = `${id >= 2 ** 30 ? 'guard' : 'client'}-${targetId}`;
      sessions.set(attached, targetId);
      result = { sessionId: attached };
    }
    if (method === 'Target.getTargetInfo') result = { targetInfo: target.info };
    if (method === 'Page.getFrameTree') result = { frameTree: target.tree };
    if (method === 'Page.getNavigationHistory')
      result = { currentIndex: 0, entries: [{ id: 1, url: target.info.url, title: 'ordinary' }] };
    if (method === 'DOM.getDocument')
      result = { root: { nodeId: 1, nodeName: '#document', children: [] } };
    emit({ id, ...(sessionId ? { sessionId } : {}), result });
  }
  function target(id) {
    const entry = {
      info: { targetId: id, type: 'page', url: ordinary },
      tree: {
        frame: { id, url: ordinary, securityOrigin: new URL(ordinary).origin },
      },
    };
    targets.set(id, entry);
    return entry;
  }
  const send = (method, params = {}, sessionId) => {
    const id = ++next;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    guard.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  };
  return { emit, send, target, delivered, flush };
}

test('twin: an ordinary redirect extraInfo is forwarded with unchanged bytes on link', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t, { kind: 'link', version: '1.60.0' });
  wire.target('page');
  const attached = await wire.send('Target.attachToTarget', { targetId: 'page', flatten: true });
  assert.equal(attached.error, undefined);
  const session = attached.result.sessionId;
  await wire.send('Network.enable', {}, session);
  for (let turn = 0; turn < 8; turn += 1) await flush();

  const ordinaryTo = `${ordinary}?next=1`;
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'ordinary-redirect',
      type: 'Document',
      frameId: 'page',
      documentURL: ordinary,
      request: { url: bounce },
    },
  });
  for (let turn = 0; turn < 8; turn += 1) await flush();
  wire.emit({
    method: 'Network.responseReceivedExtraInfo',
    sessionId: session,
    params: {
      requestId: 'ordinary-redirect',
      statusCode: 302,
      headers: redirectHeaders(ordinaryTo),
      headersText: headersText(ordinaryTo),
      blockedCookies: [],
      associatedCookies: [],
      cookiePartitionKeyOpaque: false,
    },
  });
  for (let turn = 0; turn < 20; turn += 1) await flush();

  const seen = wire.delivered.slice(mark);
  const extra = seen.find((message) => message.method === 'Network.responseReceivedExtraInfo');
  console.log(
    `ROW-OBSERVED redirect-extrainfo-twin ${JSON.stringify({
      kind: 'ordinary',
      extraLocation: Boolean(extra),
      location: extra?.params?.headers?.Location,
    })}`
  );
  assert.ok(extra, 'ordinary extraLocation: got false, want true');
  assert.equal(extra.params.headers.Location, ordinaryTo);
  assert.equal(extra.params.headersText, headersText(ordinaryTo));
});

for (const [label, route] of routes) {
  test(`redirect extraInfo with a secret Location reaches the client origin-only on ${label}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t, route);
    wire.target('page');
    const attached = await wire.send('Target.attachToTarget', { targetId: 'page', flatten: true });
    assert.equal(attached.error, undefined);
    const session = attached.result.sessionId;
    await wire.send('Network.enable', {}, session);
    for (let turn = 0; turn < 8; turn += 1) await flush();

    const mark = wire.delivered.length;
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: session,
      params: {
        requestId: 'redirect-secret',
        type: 'Document',
        frameId: 'page',
        documentURL: ordinary,
        request: { url: bounce },
      },
    });
    for (let turn = 0; turn < 8; turn += 1) await flush();
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: session,
      params: {
        requestId: 'redirect-secret',
        type: 'Document',
        frameId: 'page',
        documentURL: ordinary,
        request: { url: secret },
        redirectResponse: {
          url: bounce,
          status: 302,
          headers: redirectHeaders(secret),
        },
      },
    });
    for (let turn = 0; turn < 8; turn += 1) await flush();
    wire.emit({
      method: 'Network.responseReceivedExtraInfo',
      sessionId: session,
      params: {
        requestId: 'redirect-secret',
        statusCode: 302,
        headers: redirectHeaders(origin),
        headersText: headersText(origin),
        blockedCookies: [],
        associatedCookies: [],
        cookiePartitionKeyOpaque: false,
      },
    });
    for (let turn = 0; turn < 20; turn += 1) await flush();

    const seen = wire.delivered.slice(mark);
    const extra = seen.find((message) => message.method === 'Network.responseReceivedExtraInfo');
    const body = JSON.stringify(seen);
    const row = {
      route: label,
      extraLocation: Boolean(extra),
      location: extra?.params?.headers?.Location ?? extra?.params?.headers?.location,
      secretAbsent: !body.includes('redirect-secret-marker') && !body.includes('/private'),
    };
    console.log(`ROW-OBSERVED redirect-extrainfo ${JSON.stringify(row)}`);
    assert.ok(extra, 'extraLocation: got false, want true');
    assert.equal(extra.params.headers.Location ?? extra.params.headers.location, origin);
    assert.equal(extra.params.headers.Refresh, `0;url=${origin}`);
    assert.equal(extra.params.headers.Link, `<${origin}>; rel=preconnect`);
    assert.equal(extra.params.headersText, headersText(origin));
    assert.equal(row.secretAbsent, true, 'the secret is absent in every field');
  });
}
