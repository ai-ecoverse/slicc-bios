import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { guardProtected as stockGuard } from '../../src/seed/guard.js';

const ordinary = 'https://ordinary.invalid/page';
const bounce = 'https://ordinary.invalid/redirect';
const origin = 'https://seven.sliccy.ai';
const live = `${origin}/os/home`;
const secret = `${origin}/doc?code=redirect-secret-marker&path=/private`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const SEED = new URL('../../src/seed/', import.meta.url);
const protectedCookie = 'session=S; Domain=seven.sliccy.ai; Path=/os';
const ordinaryCookie = 'ok=1; Domain=ordinary.invalid; Path=/';

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.60.0' }],
  ['extension', { kind: 'extension', version: '7.12.0' }],
];

const hostOnlyCookie = 'session=x; Path=/; HttpOnly';
const ordinaryOrigin = 'https://ordinary.invalid';

const MUTANTS = {
  'cookie-redact-only': [
    'guard.js',
    'export function noProtectedHostSetCookie(guard, value) {\n  const lines = unfoldSetCookieLines(value);\n  if (lines === null) return false;\n  return !lines.some((line) => protectedSetCookieLine(guard, line));\n}',
    "export function noProtectedHostSetCookie(guard, value) {\n  return !(typeof value === 'string' && guard.redact({ text: value }).changed.length);\n}",
  ],
  'host-only-by-request-url': [
    [
      'this.extras = new Set();\n    this.hops = new Set();',
      'this.extras = new Set();\n    this.requestUrls = new Map();\n    this.hops = new Set();',
    ],
    [
      'const shown = this.delivered.has(requestId);\n      const marked = this.requests.get(requestId) === true || (await this.request(params));',
      "const shown = this.delivered.has(requestId);\n      const seenUrl = params.request?.url ?? params.documentURL ?? params.url;\n      if (typeof seenUrl === 'string' && seenUrl.length) this.requestUrls.set(requestId, seenUrl);\n      const marked = this.requests.get(requestId) === true || (await this.request(params));",
    ],
    [
      'provenRedirectExtraNeverForwardsPathQueryFragmentOrProtectedSetCookieOrLocation(\n        this,\n        scrubbed,\n        params\n      )',
      'provenRedirectExtraNeverForwardsPathQueryFragmentOrProtectedSetCookieOrLocation(\n        this,\n        scrubbed,\n        this.requestUrls.get(params.requestId),\n        params\n      )',
    ],
    [
      'export function protectedSetCookieLine(guard, line) {\n  const named = guard.lineDomains(line);\n  if (named !== null) return named === true;\n  return true;\n}',
      "export function protectedSetCookieLine(guard, line, responseUrl) {\n  const named = guard.lineDomains(line);\n  if (named !== null) return named === true;\n  if (typeof responseUrl !== 'string') return true;\n  return Boolean(guard.is.url(responseUrl) || guard.credential?.named?.(responseUrl));\n}",
    ],
    [
      'export function noProtectedHostSetCookie(guard, value) {\n  const lines = unfoldSetCookieLines(value);\n  if (lines === null) return false;\n  return !lines.some((line) => protectedSetCookieLine(guard, line));\n}',
      'export function noProtectedHostSetCookie(guard, value, responseUrl) {\n  const lines = unfoldSetCookieLines(value);\n  if (lines === null) return false;\n  return !lines.some((line) => protectedSetCookieLine(guard, line, responseUrl));\n}',
    ],
    [
      "function noProtectedSetCookiesInHeaders(guard, headers) {\n  const map = headerMap(headers);\n  if (!map) return true;\n  return Object.entries(map).every(([name, value]) => {\n    const key = headerName(name);\n    if (key !== 'set-cookie' && key !== 'set-cookie2') return true;\n    return noProtectedHostSetCookie(guard, value);\n  });\n}",
      "function noProtectedSetCookiesInHeaders(guard, headers, responseUrl) {\n  const map = headerMap(headers);\n  if (!map) return true;\n  return Object.entries(map).every(([name, value]) => {\n    const key = headerName(name);\n    if (key !== 'set-cookie' && key !== 'set-cookie2') return true;\n    return noProtectedHostSetCookie(guard, value, responseUrl);\n  });\n}",
    ],
    [
      "function provenRedirectExtraHeaderTexts(guard, scrubbed, original) {\n  for (const key of ['headersText', 'requestHeadersText']) {\n    const scrubbedText = scrubbed[key];\n    const originalText = original[key] ?? scrubbedText;\n    if (typeof scrubbedText === 'string' && guard.redact({ [key]: scrubbedText }).changed.length)\n      return false;\n    if (typeof originalText !== 'string') continue;\n    if (!noProtectedHostSetCookie(guard, setCookieLinesFromHeaderText(originalText))) return false;\n    if (!noProtectedLinksInHeaderText(guard, originalText)) return false;\n  }\n  return true;\n}",
      "function provenRedirectExtraHeaderTexts(guard, scrubbed, original, responseUrl) {\n  for (const key of ['headersText', 'requestHeadersText']) {\n    const scrubbedText = scrubbed[key];\n    const originalText = original[key] ?? scrubbedText;\n    if (typeof scrubbedText === 'string' && guard.redact({ [key]: scrubbedText }).changed.length)\n      return false;\n    if (typeof originalText !== 'string') continue;\n    if (!noProtectedHostSetCookie(guard, setCookieLinesFromHeaderText(originalText), responseUrl))\n      return false;\n    if (!noProtectedLinksInHeaderText(guard, originalText)) return false;\n  }\n  return true;\n}",
    ],
    [
      "export function provenRedirectExtraNeverForwardsPathQueryFragmentOrProtectedSetCookieOrLocation(\n  guard,\n  scrubbed,\n  original = scrubbed\n) {\n  if (guard.redact(scrubbed).changed.length) return false;\n  if (\n    !noProtectedCookiePartitionKey(guard, original.cookiePartitionKey) ||\n    !noProtectedCookiePartitionKey(guard, scrubbed.cookiePartitionKey)\n  )\n    return false;\n  const scrubbedHeaders = scrubbed.headers;\n  const originalHeaders = original.headers ?? scrubbedHeaders;\n  if (!noProtectedSetCookiesInHeaders(guard, originalHeaders)) return false;\n  if (\n    !originOnlyRedirectTargets(guard, scrubbedHeaders, ['location', 'content-location', 'refresh'])\n  )\n    return false;\n  if (!originOnlyRedirectTargets(guard, originalHeaders, ['link'])) return false;\n  return provenRedirectExtraHeaderTexts(guard, scrubbed, original);\n}",
      "export function provenRedirectExtraNeverForwardsPathQueryFragmentOrProtectedSetCookieOrLocation(\n  guard,\n  scrubbed,\n  responseUrl,\n  original = scrubbed\n) {\n  if (guard.redact(scrubbed).changed.length) return false;\n  if (\n    !noProtectedCookiePartitionKey(guard, original.cookiePartitionKey) ||\n    !noProtectedCookiePartitionKey(guard, scrubbed.cookiePartitionKey)\n  )\n    return false;\n  const scrubbedHeaders = scrubbed.headers;\n  const originalHeaders = original.headers ?? scrubbedHeaders;\n  if (!noProtectedSetCookiesInHeaders(guard, originalHeaders, responseUrl)) return false;\n  if (\n    !originOnlyRedirectTargets(guard, scrubbedHeaders, ['location', 'content-location', 'refresh'])\n  )\n    return false;\n  if (!originOnlyRedirectTargets(guard, originalHeaders, ['link'])) return false;\n  return provenRedirectExtraHeaderTexts(guard, scrubbed, original, responseUrl);\n}",
    ],
  ],
};

const mutantPatches = (entry) => (typeof entry[0] === 'string' ? [[entry[1], entry[2]]] : entry);

registerHooks({
  resolve(specifier, context, next) {
    const mutant = context.parentURL && URL.parse(context.parentURL)?.searchParams.get('mutant');
    const resolved = next(specifier, context);
    if (
      !mutant ||
      !MUTANTS[mutant] ||
      !specifier.startsWith('./') ||
      specifier.slice(2) !== 'guard.js'
    )
      return resolved;
    return { ...resolved, url: `${resolved.url}?mutant=${mutant}` };
  },
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant || !MUTANTS[mutant] || !url.split('?')[0].endsWith('/guard.js')) return loaded;
    let source = String(loaded.source);
    for (const [from, to] of mutantPatches(MUTANTS[mutant])) {
      assert.ok(source.includes(from), `mutant ${mutant}: ${from} is not in the source`);
      source = source.replace(from, to);
    }
    return { ...loaded, source };
  },
});

const loadGuard = async (mutant) => {
  if (!mutant) return stockGuard;
  return (await import(`${new URL('guard.js', SEED).href}?mutant=${mutant}`)).guardProtected;
};

const redirectHeaders = (to, extra = {}) => ({
  Location: to,
  Refresh: `0;url=${to}`,
  Link: `<${to}>; rel=preconnect`,
  ...extra,
});

const headersText = (to, cookieLines = []) =>
  [
    'HTTP/1.1 302 Found',
    `Location: ${to}`,
    `Refresh: 0;url=${to}`,
    `Link: <${to}>; rel=preconnect`,
    ...cookieLines.map((line) => `Set-Cookie: ${line}`),
    '',
    '',
  ].join('\r\n');

function protocol(t, route, guardProtected = stockGuard) {
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
  function target(id, url = ordinary) {
    const entry = {
      info: { targetId: id, type: 'page', url, title: url },
      tree: {
        frame: { id, url, securityOrigin: new URL(url).origin },
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

async function primed(t, { route, guardProtected = stockGuard, requestUrl = bounce } = {}) {
  const wire = protocol(t, route, guardProtected);
  wire.target('page');
  const attached = await wire.send('Target.attachToTarget', { targetId: 'page', flatten: true });
  assert.equal(attached.error, undefined);
  const session = attached.result.sessionId;
  await wire.send('Network.enable', {}, session);
  for (let turn = 0; turn < 8; turn += 1) await flush();
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'redirect',
      type: 'Document',
      frameId: 'page',
      documentURL: ordinary,
      request: { url: bounce },
    },
  });
  for (let turn = 0; turn < 8; turn += 1) await flush();
  if (requestUrl !== bounce) {
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: session,
      params: {
        requestId: 'redirect',
        type: 'Document',
        frameId: 'page',
        documentURL: ordinary,
        request: { url: requestUrl },
        redirectResponse: {
          url: bounce,
          status: 302,
          headers: redirectHeaders(requestUrl),
        },
      },
    });
    for (let turn = 0; turn < 8; turn += 1) await flush();
  }
  return { wire, session };
}

async function emitExtra(wire, session, params) {
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Network.responseReceivedExtraInfo',
    sessionId: session,
    params: {
      requestId: 'redirect',
      statusCode: 302,
      blockedCookies: [],
      associatedCookies: [],
      cookiePartitionKeyOpaque: false,
      ...params,
    },
  });
  for (let turn = 0; turn < 20; turn += 1) await flush();
  return wire.delivered
    .slice(mark)
    .find((message) => message.method === 'Network.responseReceivedExtraInfo');
}

function observed(kind, extra) {
  const row = { kind, extraLocation: Boolean(extra) };
  console.log(`ROW-OBSERVED redirect-extrainfo-twin ${JSON.stringify(row)}`);
  return row;
}

test('twin: an ordinary redirect extraInfo is forwarded with unchanged bytes on link', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { route: { kind: 'link', version: '1.60.0' } });
  const ordinaryTo = `${ordinary}?next=1`;
  const extra = await emitExtra(wire, session, {
    headers: redirectHeaders(ordinaryTo),
    headersText: headersText(ordinaryTo),
  });
  observed('ordinary', extra);
  assert.ok(extra, 'ordinary extraLocation: got false, want true');
  assert.equal(extra.params.headers.Location, ordinaryTo);
  assert.equal(extra.params.headersText, headersText(ordinaryTo));
});

for (const [label, route] of routes) {
  test(`redirect extraInfo with a secret Location reaches the client origin-only on ${label}`, {
    timeout: 5000,
  }, async (t) => {
    const { wire, session } = await primed(t, { route });
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: session,
      params: {
        requestId: 'redirect',
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
    const mark = wire.delivered.length;
    const extra = await emitExtra(wire, session, {
      headers: redirectHeaders(origin),
      headersText: headersText(origin),
    });
    const body = JSON.stringify(wire.delivered.slice(mark));
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

test('twin: origin-only Location with a protected Domain Set-Cookie is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: redirectHeaders(origin, { 'Set-Cookie': protectedCookie }),
    headersText: headersText(origin, [protectedCookie]),
  });
  observed('set-cookie-string', extra);
  assert.equal(extra, undefined);
});

test('twin: origin-only Location with a protected Set-Cookie array is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: redirectHeaders(origin, {
      'Set-Cookie': [ordinaryCookie, protectedCookie],
    }),
    headersText: headersText(origin),
  });
  observed('set-cookie-array', extra);
  assert.equal(extra, undefined);
});

test('twin: origin-only Location with a newline-folded protected Set-Cookie is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const folded = 'session=S;\r\n Domain=seven.sliccy.ai; Path=/os';
  const extra = await emitExtra(wire, session, {
    headers: redirectHeaders(origin, { 'Set-Cookie': folded }),
    headersText: headersText(origin),
  });
  observed('set-cookie-folded', extra);
  assert.equal(extra, undefined);
});

test('twin: protected Set-Cookie only in headersText is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: redirectHeaders(origin),
    headersText: headersText(origin, [protectedCookie]),
  });
  observed('set-cookie-headersText', extra);
  assert.equal(extra, undefined);
});

test('twin: mixed-case Set-Cookie with a protected Domain is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: { Location: origin, 'SET-Cookie': protectedCookie },
    headersText: `HTTP/1.1 302 Found\r\nLocation: ${origin}\r\nSET-Cookie: ${protectedCookie}\r\n\r\n`,
  });
  observed('set-cookie-mixed-case', extra);
  assert.equal(extra, undefined);
});

test('twin: host-only Set-Cookie on a protected response URL is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const hostOnly = 'session=S; Path=/os';
  const extra = await emitExtra(wire, session, {
    headers: redirectHeaders(origin, { 'Set-Cookie': hostOnly }),
    headersText: headersText(origin, [hostOnly]),
  });
  observed('set-cookie-host-only-protected', extra);
  assert.equal(extra, undefined);
});

test('twin: host-only Set-Cookie on the protected hop of ordinary->protected->ordinary is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'redirect',
      type: 'Document',
      frameId: 'page',
      documentURL: ordinary,
      request: { url: ordinary },
      redirectResponse: {
        url: live,
        status: 302,
        headers: redirectHeaders(ordinaryOrigin),
      },
    },
  });
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const extra = await emitExtra(wire, session, {
    headers: { Location: ordinaryOrigin, 'Set-Cookie': hostOnlyCookie },
    headersText: `HTTP/1.1 302 Found\r\nLocation: ${ordinaryOrigin}\r\nSet-Cookie: ${hostOnlyCookie}\r\n\r\n`,
  });
  observed('host-only-chain-after-next-willBeSent', extra);
  assert.equal(extra, undefined);
});

test('twin: host-only Set-Cookie before the next requestWillBeSent is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: { Location: ordinaryOrigin, 'Set-Cookie': hostOnlyCookie },
    headersText: `HTTP/1.1 302 Found\r\nLocation: ${ordinaryOrigin}\r\nSet-Cookie: ${hostOnlyCookie}\r\n\r\n`,
  });
  observed('host-only-chain-before-next-willBeSent', extra);
  assert.equal(extra, undefined);
});

test('twin: ordinary unredacted redirect with a host-only Set-Cookie still forwards byte-identical', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t);
  const ordinaryTo = `${ordinary}?next=1`;
  const headers = redirectHeaders(ordinaryTo, { 'Set-Cookie': hostOnlyCookie });
  const text = headersText(ordinaryTo, [hostOnlyCookie]);
  const extra = await emitExtra(wire, session, {
    headers,
    headersText: text,
  });
  observed('host-only-ordinary-unredacted', extra);
  assert.ok(extra, 'ordinary unredacted host-only cookie must still forward');
  assert.deepEqual(extra.params.headers, headers);
  assert.equal(extra.params.headersText, text);
  assert.equal(extra.params.headers['Set-Cookie'], hostOnlyCookie);
});

test('twin: ordinary Domain Set-Cookie with origin-only Location still forwards', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: redirectHeaders(origin, { 'Set-Cookie': ordinaryCookie }),
    headersText: headersText(origin, [ordinaryCookie]),
  });
  observed('set-cookie-ordinary', extra);
  assert.ok(extra, 'ordinary cookie must still forward');
  assert.equal(extra.params.headers.Location, origin);
  assert.equal(extra.params.headers['Set-Cookie'], ordinaryCookie);
});

test('twin: padded Set-Cookie name with a protected Domain is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: { Location: origin, 'Set-Cookie ': protectedCookie },
    headersText: headersText(origin),
  });
  observed('set-cookie-padded-name', extra);
  assert.equal(extra, undefined);
});

test('twin: protected cookiePartitionKey topLevelSite is dropped', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: { Location: 'https://ordinary.invalid' },
    cookiePartitionKey: { topLevelSite: origin, hasCrossSiteAncestor: false },
  });
  observed('cookie-partition-protected', extra);
  assert.equal(extra, undefined);
});

test('twin: ordinary cookiePartitionKey topLevelSite still forwards', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const ordinarySite = 'https://ordinary.invalid';
  const extra = await emitExtra(wire, session, {
    headers: { Location: ordinarySite },
    cookiePartitionKey: { topLevelSite: ordinarySite, hasCrossSiteAncestor: false },
  });
  observed('cookie-partition-ordinary', extra);
  assert.ok(extra, 'ordinary partition key must still forward');
  assert.equal(extra.params.headers.Location, ordinarySite);
  assert.equal(extra.params.cookiePartitionKey.topLevelSite, ordinarySite);
});

test('twin: a second protected Link URI drops the origin-only Location event', {
  timeout: 5000,
}, async (t) => {
  const { wire, session } = await primed(t, { requestUrl: live });
  const link = `<${origin}>; rel=preconnect, <${origin}/os/private>; rel=prefetch`;
  const extra = await emitExtra(wire, session, {
    headers: { Location: origin, Link: link },
    headersText: `HTTP/1.1 302 Found\r\nLocation: ${origin}\r\nLink: ${link}\r\n\r\n`,
  });
  observed('link-second-protected', extra);
  assert.equal(extra, undefined);
});

test('mutant: redact-changed Set-Cookie check forwards the protected Domain rows', {
  timeout: 5000,
}, async (t) => {
  const guardProtected = await loadGuard('cookie-redact-only');
  const { wire, session } = await primed(t, { guardProtected, requestUrl: live });
  const extra = await emitExtra(wire, session, {
    headers: redirectHeaders(origin, { 'Set-Cookie': protectedCookie }),
    headersText: headersText(origin, [protectedCookie]),
  });
  console.log(
    `ROW-OBSERVED redirect-extrainfo-mutant ${JSON.stringify({
      kind: 'cookie-redact-only',
      extraLocation: Boolean(extra),
    })}`
  );
  assert.ok(extra, 'mutant must turn the protected Set-Cookie drop rows red');
  assert.equal(extra.params.headers.Location, origin);
});

test('mutant: host-only judged by latest request URL forwards the chain row', {
  timeout: 5000,
}, async (t) => {
  const guardProtected = await loadGuard('host-only-by-request-url');
  const { wire, session } = await primed(t, { guardProtected, requestUrl: live });
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'redirect',
      type: 'Document',
      frameId: 'page',
      documentURL: ordinary,
      request: { url: ordinary },
      redirectResponse: {
        url: live,
        status: 302,
        headers: redirectHeaders(ordinaryOrigin),
      },
    },
  });
  for (let turn = 0; turn < 8; turn += 1) await flush();
  const extra = await emitExtra(wire, session, {
    headers: { Location: ordinaryOrigin, 'Set-Cookie': hostOnlyCookie },
    headersText: `HTTP/1.1 302 Found\r\nLocation: ${ordinaryOrigin}\r\nSet-Cookie: ${hostOnlyCookie}\r\n\r\n`,
  });
  console.log(
    `ROW-OBSERVED redirect-extrainfo-mutant ${JSON.stringify({
      kind: 'host-only-by-request-url',
      extraLocation: Boolean(extra),
    })}`
  );
  assert.ok(extra, 'mutant must turn host-only-chain-after-next-willBeSent red');
  assert.equal(extra.params.headers.Location, ordinaryOrigin);
  assert.equal(extra.params.headers['Set-Cookie'], hostOnlyCookie);
});
