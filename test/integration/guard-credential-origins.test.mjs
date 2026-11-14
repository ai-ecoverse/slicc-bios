import assert from 'node:assert/strict';
import { test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { flush, protocol } from './guard-ordering-fixture.mjs';

const { CREDENTIAL, guardProtected, PROTECTED } = await import(
  process.env.GUARD_SOURCE ?? '../../src/seed/guard.js'
);

const IDP = 'https://ims-na1.adobelogin.com';
const STAGE = 'https://ims-na1-stg1.adobelogin.com';
const LOGIN = 'https://auth.services.adobe.com';
const ADOBE_ID = 'https://adobeid-na1.services.adobe.com';
const PAGE = `${IDP}/ims/login?locale=en`;
const ORDINARY = 'https://ordinary.example';
const SECRET = 'synthetic-credential-secret';

const routes = [
  ['devtools', undefined],
  ['link', { kind: 'link', version: '1.60.0' }],
  ['extension', { kind: 'extension', version: '7.12.0' }],
];

const frames = async () => [];
const wired = (t, route) =>
  protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route, frames));

async function answered(wire, method, params, sessionId, result) {
  wire.hold((message) => message.id < 2 ** 30 && message.method === method);
  const read = wire.request(method, params, sessionId);
  let answer;
  void read.answer.then((value) => {
    answer = value;
  });
  for (let turn = 0; turn < 200 && !answer; turn += 1) {
    const held = wire.held.find((message) => message.id === read.id);
    if (held) {
      wire.hold(() => false);
      wire.release(held, { result });
      return read.answer;
    }
    await flush();
  }
  wire.hold(() => false);
  return read.answer;
}

const forwarded = (wire, mark, method) =>
  wire.clients(mark).filter((message) => message.method === method);

async function refused(wire, method, params, sessionId, text = CREDENTIAL) {
  const mark = wire.sent.length;
  const answer = await wire.send(method, params, sessionId);
  assert.equal(answer.error?.message, text, `${method} ${JSON.stringify(params)}`);
  assert.equal(answer.result, undefined);
  assert.deepEqual(forwarded(wire, mark, method), [], `${method} reached the browser`);
}

async function passed(wire, method, params, sessionId) {
  const mark = wire.sent.length;
  const answer = await wire.send(method, params, sessionId);
  assert.equal(answer.error, undefined, `${method} ${JSON.stringify(params)}`);
  assert.equal(forwarded(wire, mark, method).length, 1, `${method} didn't reach the browser`);
  return answer;
}

const idpFrame = (id) => ({ id, url: PAGE, securityOrigin: IDP });

async function idpPage(wire, id = 'idp') {
  wire.target(id, 'page', idpFrame(id));
  return wire.attach(id);
}

const withheldCookies = [
  { name: 'host', value: SECRET, domain: 'ims-na1.adobelogin.com', path: '/' },
  { name: 'parent', value: SECRET, domain: '.adobelogin.com', path: '/' },
  { name: 'stage', value: SECRET, domain: 'IMS-NA1-STG1.adobelogin.com.', path: '/' },
  { name: 'bare', value: SECRET, domain: 'adobelogin.com', path: '/' },
  {
    name: 'partitioned',
    value: SECRET,
    domain: 'ordinary.example',
    path: '/',
    partitionKey: { topLevelSite: 'https://adobelogin.com', hasCrossSiteAncestor: true },
  },
  {
    name: 'partitioned-host',
    value: SECRET,
    domain: 'ordinary.example',
    path: '/',
    partitionKey: { topLevelSite: IDP, hasCrossSiteAncestor: false },
  },
  {
    name: 'partitioned-text',
    value: SECRET,
    domain: 'ordinary.example',
    path: '/',
    partitionKey: 'https://adobelogin.com',
  },
  { name: 'nameless', value: SECRET, path: '/' },
  { name: 'adobe', value: SECRET, domain: '.adobe.com', path: '/' },
  { name: 'services', value: SECRET, domain: 'services.adobe.com', path: '/' },
  { name: 'login', value: SECRET, domain: 'auth.services.adobe.com', path: '/' },
  { name: 'adobe-id', value: SECRET, domain: '.adobeid-na1.services.adobe.com', path: '/' },
  {
    name: 'partitioned-adobe',
    value: SECRET,
    domain: 'ordinary.example',
    path: '/',
    partitionKey: { topLevelSite: 'https://adobe.com', hasCrossSiteAncestor: true },
  },
];
const keptCookies = [
  { name: 'ordinary', value: 'visible', domain: 'ordinary.example', path: '/' },
  { name: 'sub-host', value: 'visible', domain: 'x.ims-na1.adobelogin.com', path: '/' },
  { name: 'sibling', value: 'visible', domain: 'other.adobelogin.com', path: '/' },
  { name: 'www', value: 'visible', domain: 'www.adobe.com', path: '/' },
  { name: 'helpx', value: 'visible', domain: '.helpx.adobe.com', path: '/' },
  { name: 'login-sub', value: 'visible', domain: 'x.auth.services.adobe.com', path: '/' },
  { name: 'adobe-lookalike', value: 'visible', domain: 'adobe.com.evil.example', path: '/' },
  { name: 'lookalike', value: 'visible', domain: 'ims-na1.adobelogin.com.evil.example', path: '/' },
  {
    name: 'partitioned-ordinary',
    value: 'visible',
    domain: 'cdn.example',
    path: '/',
    partitionKey: { topLevelSite: ORDINARY, hasCrossSiteAncestor: true },
  },
];
const jar = [...withheldCookies, ...keptCookies];
const names = (answer) => answer.result?.cookies?.map((cookie) => cookie.name);

test('the catalog names the credential origins and their refusal', () => {
  const origins = catalog.credentialOrigins?.origins;
  assert.ok(Array.isArray(origins), 'catalog.credentialOrigins.origins is a list');
  assert.ok(origins.includes(IDP));
  assert.ok(origins.includes(STAGE));
  assert.ok(origins.includes(LOGIN));
  assert.ok(origins.includes(ADOBE_ID));
  assert.equal(typeof catalog.credentialOrigins.refusal, 'string');
  assert.equal(CREDENTIAL, catalog.credentialOrigins.refusal);
  assert.notEqual(CREDENTIAL, PROTECTED);
  for (const origin of origins) {
    assert.ok(!(catalog.protectedOrigins.hosts ?? []).includes(new URL(origin).hostname));
  }
});

for (const [label, route] of routes) {
  test(`credential cookies are left out of cookie reads on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const session = await idpPage(wire);
    const reads = [
      ['Network.getAllCookies', {}, undefined],
      ['Network.getCookies', {}, session],
      ['Network.getCookies', { urls: [`${IDP}/`] }, session],
      ['Network.getCookies', { urls: [`${ORDINARY}/`, `${STAGE}/`] }, session],
      ['Storage.getCookies', {}, undefined],
      ['Storage.getCookies', { browserContextId: 'context-1' }, undefined],
      ['Page.getCookies', {}, session],
    ];
    for (const [method, params, at] of reads) {
      const answer = await answered(wire, method, params, at, { cookies: jar });
      assert.equal(answer.error, undefined, method);
      assert.deepEqual(
        names(answer),
        keptCookies.map((cookie) => cookie.name),
        `${method} ${JSON.stringify(params)}`
      );
      assert.ok(!JSON.stringify(answer).includes(SECRET), method);
    }
  });

  test(`credential cookie writes and deletes are refused on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const session = await idpPage(wire);
    const cookie = { name: 'planted', value: 'x' };
    const writes = [
      ['Network.setCookie', { ...cookie, url: `${IDP}/` }],
      ['Network.setCookie', { ...cookie, url: 'http://IMS-NA1.adobelogin.com.:8443/path?q#f' }],
      ['Network.setCookie', { ...cookie, url: `${STAGE}/` }],
      ['Network.setCookie', { ...cookie, url: `${LOGIN}/signin` }],
      ['Network.setCookie', { ...cookie, url: `${ADOBE_ID}/` }],
      ['Network.setCookie', { ...cookie, url: `${ORDINARY}/`, domain: '.adobe.com' }],
      ['Network.setCookie', { ...cookie, domain: 'services.adobe.com' }],
      ['Network.setCookie', { ...cookie, url: `${ORDINARY}/`, domain: '.adobelogin.com' }],
      ['Network.setCookie', { ...cookie, domain: 'ims-na1.adobelogin.com' }],
      [
        'Network.setCookie',
        {
          ...cookie,
          url: `${ORDINARY}/`,
          partitionKey: { topLevelSite: 'https://adobelogin.com' },
        },
      ],
      [
        'Network.setCookies',
        {
          cookies: [
            { ...cookie, url: `${ORDINARY}/` },
            { ...cookie, url: `${IDP}/` },
          ],
        },
      ],
      ['Network.deleteCookies', { name: 'host', url: `${IDP}/` }],
      ['Network.deleteCookies', { name: 'parent', domain: 'adobelogin.com' }],
      [
        'Network.deleteCookies',
        { name: 'p', url: `${ORDINARY}/`, partitionKey: { topLevelSite: IDP } },
      ],
      ['Storage.setCookies', { cookies: [{ ...cookie, domain: '.ims-na1-stg1.adobelogin.com' }] }],
      [
        'Storage.setCookies',
        { cookies: [{ ...cookie, url: `${IDP}/` }], browserContextId: 'context-1' },
      ],
    ];
    for (const [method, params] of writes) await refused(wire, method, params);
    await refused(wire, 'Page.deleteCookie', { cookieName: 'host', url: `${IDP}/` }, session);
  });

  test(`ordinary cookie writes still reach the browser on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const cookie = { name: 'plain', value: 'x' };
    for (const params of [
      { ...cookie, url: `${ORDINARY}/` },
      { ...cookie, url: 'https://x.ims-na1.adobelogin.com/' },
      { ...cookie, url: 'https://ims-na1.adobelogin.com.evil.example/' },
      { ...cookie, url: 'https://other.adobelogin.com/' },
      { ...cookie, domain: 'x.ims-na1.adobelogin.com' },
      { ...cookie, url: 'https://www.adobe.com/' },
      { ...cookie, url: 'https://helpx.adobe.com/' },
      { ...cookie, url: 'https://x.auth.services.adobe.com/' },
      { ...cookie, domain: 'www.adobe.com' },
      { ...cookie, url: `${ORDINARY}/`, partitionKey: { topLevelSite: ORDINARY } },
    ])
      await passed(wire, 'Network.setCookie', params);
    await passed(wire, 'Network.deleteCookies', { name: 'plain', url: `${ORDINARY}/` });
    await passed(wire, 'Storage.setCookies', { cookies: [{ ...cookie, url: `${ORDINARY}/` }] });
  });

  test(`clearing every cookie keeps its existing rule on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    await refused(wire, 'Network.clearBrowserCookies', {}, undefined, PROTECTED);
    await refused(wire, 'Storage.clearCookies', {}, undefined, PROTECTED);
  });

  test(`storage commands naming a credential origin are refused on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const key = `${IDP}/`;
    const commands = [
      ['Storage.getUsageAndQuota', { origin: IDP }],
      ['Storage.getUsageAndQuota', { origin: 'https://IMS-NA1.adobelogin.com.:8443' }],
      ['Storage.getUsageAndQuota', { origin: 'http://ims-na1-stg1.adobelogin.com' }],
      ['Storage.getUsageAndQuota', { origin: 'not a url' }],
      ['Storage.getUsageAndQuota', { origin: LOGIN }],
      [
        'DOMStorage.getDOMStorageItems',
        { storageId: { securityOrigin: ADOBE_ID, isLocalStorage: true } },
      ],
      ['IndexedDB.requestDatabaseNames', { storageKey: `${ORDINARY}/^0https://adobe.com` }],
      ['Storage.clearDataForOrigin', { origin: IDP, storageTypes: 'all' }],
      ['Storage.clearDataForStorageKey', { storageKey: key, storageTypes: 'all' }],
      ['Storage.getSharedStorageEntries', { ownerOrigin: IDP }],
      ['Storage.getSharedStorageMetadata', { ownerOrigin: IDP }],
      ['Storage.setSharedStorageEntry', { ownerOrigin: IDP, key: 'k', value: 'v' }],
      ['Storage.getInterestGroupDetails', { ownerOrigin: IDP, name: 'group' }],
      ['Storage.clearTrustTokens', { issuerOrigin: IDP }],
      ['Storage.overrideQuotaForOrigin', { origin: IDP, quotaSize: 1 }],
      ['Storage.trackCacheStorageForOrigin', { origin: IDP }],
      ['Storage.trackIndexedDBForStorageKey', { storageKey: key }],
      ['Storage.setStorageBucketTracking', { storageKey: key, enable: true }],
      ['Storage.deleteStorageBucket', { bucket: { storageKey: key, name: 'b' } }],
      ['IndexedDB.requestDatabaseNames', { securityOrigin: IDP }],
      ['IndexedDB.requestDatabaseNames', { storageKey: key }],
      ['IndexedDB.requestDatabaseNames', { storageKey: `${ORDINARY}/^0https://adobelogin.com` }],
      ['IndexedDB.requestDatabaseNames', { storageBucket: { storageKey: key, name: 'default' } }],
      ['IndexedDB.requestDatabase', { securityOrigin: IDP, databaseName: 'tokens' }],
      [
        'IndexedDB.requestData',
        {
          storageKey: key,
          databaseName: 'tokens',
          objectStoreName: 'store',
          indexName: '',
          skipCount: 0,
          pageSize: 10,
        },
      ],
      [
        'IndexedDB.getMetadata',
        { securityOrigin: IDP, databaseName: 'tokens', objectStoreName: 's' },
      ],
      ['IndexedDB.deleteDatabase', { storageKey: key, databaseName: 'tokens' }],
      ['CacheStorage.requestCacheNames', { securityOrigin: IDP }],
      ['CacheStorage.requestCacheNames', { storageKey: key }],
      ['CacheStorage.requestEntries', { cacheId: `${key}|tokens`, skipCount: 0, pageSize: 10 }],
      ['CacheStorage.deleteCache', { cacheId: `${key}|tokens` }],
      [
        'CacheStorage.requestCachedResponse',
        { cacheId: `${key}|tokens`, requestURL: `${IDP}/x`, requestHeaders: [] },
      ],
      [
        'DOMStorage.getDOMStorageItems',
        { storageId: { securityOrigin: IDP, isLocalStorage: true } },
      ],
      ['DOMStorage.getDOMStorageItems', { storageId: { storageKey: key, isLocalStorage: false } }],
      [
        'DOMStorage.setDOMStorageItem',
        { storageId: { securityOrigin: IDP, isLocalStorage: true }, key: 'k', value: 'v' },
      ],
      [
        'DOMStorage.removeDOMStorageItem',
        { storageId: { securityOrigin: STAGE, isLocalStorage: true }, key: 'k' },
      ],
      ['DOMStorage.clear', { storageId: { storageKey: key, isLocalStorage: true } }],
      [
        'FileSystem.getDirectory',
        { bucketFileSystemLocator: { storageKey: key, bucketName: 'b', pathComponents: [] } },
      ],
    ];
    for (const [method, params] of commands) await refused(wire, method, params);
  });

  test(`storage commands on ordinary origins still reach the browser on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    for (const origin of [
      ORDINARY,
      'https://x.ims-na1.adobelogin.com',
      'https://ims-na1.adobelogin.com.evil.example',
      'https://other.adobelogin.com',
      'ftp://ims-na1.adobelogin.com',
      'https://www.adobe.com',
      'https://helpx.adobe.com',
      'https://x.auth.services.adobe.com',
    ])
      await passed(wire, 'Storage.getUsageAndQuota', { origin });
    await passed(wire, 'IndexedDB.requestDatabaseNames', { storageKey: `${ORDINARY}/` });
    await passed(wire, 'IndexedDB.requestDatabaseNames', {
      storageKey: `${ORDINARY}/^0https://example.test`,
    });
    await passed(wire, 'CacheStorage.requestEntries', {
      cacheId: `${ORDINARY}/|assets`,
      skipCount: 0,
      pageSize: 10,
    });
    await passed(wire, 'DOMStorage.getDOMStorageItems', {
      storageId: { securityOrigin: ORDINARY, isLocalStorage: true },
    });
  });

  test(`trust tokens stay refused whole on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    await refused(wire, 'Storage.getTrustTokens', {}, undefined, PROTECTED);
  });

  test(`affected URLs leave out credential origins on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const answer = await answered(
      wire,
      'Storage.getAffectedUrlsForThirdPartyCookieMetadata',
      { firstPartyUrl: `${ORDINARY}/`, thirdPartyUrls: [`${IDP}/x`, 'https://cdn.example/'] },
      undefined,
      { matchedUrls: [`${IDP}/x`, `${STAGE}/y`, 'https://cdn.example/'] }
    );
    assert.equal(answer.error, undefined);
    assert.deepEqual(answer.result.matchedUrls, ['https://cdn.example/']);
  });

  test(`storage events naming a credential origin are dropped on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const session = await idpPage(wire);
    const key = `${IDP}/`;
    const dropped = [
      ['Storage.cacheStorageContentUpdated', { origin: IDP, storageKey: key, cacheName: 'c' }],
      ['Storage.cacheStorageListUpdated', { origin: '', storageKey: key, bucketId: '1' }],
      ['Storage.indexedDBContentUpdated', { origin: IDP, storageKey: '', databaseName: 'd' }],
      ['Storage.indexedDBListUpdated', { origin: STAGE, storageKey: '', bucketId: '1' }],
      ['Storage.interestGroupAccessed', { ownerOrigin: IDP, name: 'g', type: 'join' }],
      ['Storage.sharedStorageAccessed', { ownerOrigin: '', ownerSite: 'https://adobelogin.com' }],
      ['Storage.storageBucketCreatedOrUpdated', { bucketInfo: { bucket: { storageKey: key } } }],
    ];
    const domDropped = [
      [
        'DOMStorage.domStorageItemAdded',
        { storageId: { securityOrigin: IDP, isLocalStorage: true }, key: 'k', newValue: SECRET },
      ],
      [
        'DOMStorage.domStorageItemUpdated',
        { storageId: { storageKey: key, isLocalStorage: true }, key: 'k', newValue: SECRET },
      ],
      ['DOMStorage.domStorageItemsCleared', { storageId: { securityOrigin: IDP } }],
    ];
    const mark = wire.delivered.length;
    for (const [method, params] of dropped) wire.emit({ method, params });
    for (const [method, params] of domDropped) wire.emit({ method, params, sessionId: session });
    wire.emit({
      method: 'Storage.cacheStorageContentUpdated',
      params: { origin: ORDINARY, storageKey: `${ORDINARY}/`, cacheName: 'plain' },
    });
    wire.emit({
      method: 'DOMStorage.domStorageItemAdded',
      sessionId: session,
      params: {
        storageId: { securityOrigin: ORDINARY, isLocalStorage: true },
        key: 'k',
        newValue: 'visible',
      },
    });
    for (let turn = 0; turn < 20; turn += 1) await flush();
    const seen = wire.delivered.slice(mark);
    assert.ok(!JSON.stringify(seen).includes(SECRET));
    assert.deepEqual(seen.map((message) => message.method).sort(), [
      'DOMStorage.domStorageItemAdded',
      'Storage.cacheStorageContentUpdated',
    ]);
    const cache = seen.find((message) => message.method.startsWith('Storage.'));
    const item = seen.find((message) => message.method.startsWith('DOMStorage.'));
    assert.equal(cache.params.origin, ORDINARY);
    assert.equal(item.params.newValue, 'visible');
  });

  test(`cookie headers of credential requests are stripped from events on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const session = await idpPage(wire);
    await wire.send('Network.enable', {}, session);
    const mark = wire.delivered.length;
    const emit = (method, params) => wire.emit({ method, sessionId: session, params });
    emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'idp-1',
      associatedCookies: [
        {
          cookie: { name: 'parent', value: SECRET, domain: '.adobelogin.com' },
          blockedReasons: [],
        },
      ],
      headers: { Cookie: `parent=${SECRET}`, Accept: 'text/html' },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'idp-1',
      loaderId: 'loader',
      documentURL: PAGE,
      frameId: 'idp',
      type: 'XHR',
      request: { url: `${IDP}/ims/check`, method: 'GET', headers: { cookie: `p=${SECRET}` } },
    });
    emit('Network.responseReceivedExtraInfo', {
      requestId: 'idp-1',
      statusCode: 200,
      headers: { 'set-cookie': `host=${SECRET}`, 'content-type': 'text/html' },
      headersText: `HTTP/1.1 200 OK\r\nSet-Cookie: host=${SECRET}\r\n folded-${SECRET}\r\nContent-Type: text/html\r\n\r\n`,
      blockedCookies: [{ blockedReasons: ['SecureOnly'], cookieLine: `host=${SECRET}` }],
      exemptedCookies: [
        {
          cookie: { name: 'host', value: SECRET, domain: 'ims-na1.adobelogin.com' },
          cookieLine: `host=${SECRET}`,
          exemptionReason: 'None',
        },
      ],
    });
    emit('Network.responseReceived', {
      requestId: 'idp-1',
      loaderId: 'loader',
      frameId: 'idp',
      type: 'XHR',
      response: {
        url: `${IDP}/ims/check`,
        status: 200,
        headers: { 'Set-Cookie': `host=${SECRET}`, 'Content-Type': 'text/html' },
        requestHeaders: { Cookie: `parent=${SECRET}` },
        headersText: `HTTP/1.1 200 OK\nset-cookie: host=${SECRET}\n`,
        requestHeadersText: `GET /ims/check HTTP/1.1\nCookie: parent=${SECRET}\n`,
      },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'sibling-1',
      loaderId: 'loader',
      documentURL: PAGE,
      frameId: 'idp',
      type: 'XHR',
      request: { url: 'https://other.adobelogin.com/x', method: 'GET', headers: {} },
    });
    emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'sibling-1',
      associatedCookies: [],
      headers: { Cookie: `parent=${SECRET}` },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'hop-1',
      loaderId: 'loader',
      documentURL: PAGE,
      frameId: 'idp',
      type: 'Document',
      request: { url: `${ORDINARY}/callback`, method: 'GET', headers: {} },
      redirectResponse: {
        url: `${IDP}/ims/authorize`,
        status: 302,
        headers: { 'Set-Cookie': `host=${SECRET}`, Location: `${ORDINARY}/callback` },
      },
    });
    emit('Audits.issueAdded', {
      issue: {
        code: 'CookieIssue',
        details: {
          cookieIssueDetails: {
            rawCookieLine: `host=${SECRET}`,
            cookieWarningReasons: [],
            cookieExclusionReasons: [],
            operation: 'SetCookie',
            cookieUrl: `${IDP}/ims/check`,
            request: { requestId: 'idp-1' },
          },
        },
      },
    });
    emit('Audits.issueAdded', {
      issue: {
        code: 'CookieIssue',
        details: {
          cookieIssueDetails: {
            rawCookieLine: `plain=${SECRET}; Domain=ordinary.example`,
            cookieWarningReasons: [],
            cookieExclusionReasons: [],
            operation: 'ReadCookie',
            request: { requestId: 'idp-1' },
          },
        },
      },
    });
    for (let turn = 0; turn < 40; turn += 1) await flush();
    const seen = wire.delivered.slice(mark);
    assert.ok(!JSON.stringify(seen).includes(SECRET), JSON.stringify(seen));
    const extra = seen.find((message) => message.method === 'Network.requestWillBeSentExtraInfo');
    assert.deepEqual(extra?.params.headers, { Accept: 'text/html' });
    assert.deepEqual(extra?.params.associatedCookies, []);
    const response = seen.find((message) => message.method === 'Network.responseReceivedExtraInfo');
    assert.deepEqual(response?.params.headers, { 'content-type': 'text/html' });
    assert.equal(
      response?.params.headersText,
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n'
    );
    const received = seen.find((message) => message.method === 'Network.responseReceived');
    assert.deepEqual(received?.params.response.headers, { 'Content-Type': 'text/html' });
    const hop = seen.find((message) => message.params?.requestId === 'hop-1');
    assert.deepEqual(hop?.params.redirectResponse.headers, { Location: `${ORDINARY}/callback` });
    assert.equal(seen.filter((message) => message.method === 'Audits.issueAdded').length, 0);
  });

  test(`cookie issues naming a credential or protected origin are dropped on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    wire.target('plain', 'page', { id: 'plain', url: `${ORDINARY}/`, securityOrigin: ORDINARY });
    const session = await wire.attach('plain');
    await wire.send('Audits.enable', {}, session);
    const base = {
      cookieWarningReasons: [],
      cookieExclusionReasons: ['ExcludeSameSiteLax'],
      operation: 'SetCookie',
    };
    const dropped = [
      { request: { requestId: 'x-1', url: `${IDP}/ims/check` } },
      { request: { requestId: 'x-2', url: 'https://www.sliccy.ai/api' } },
      { cookie: { name: 'host', domain: '.adobelogin.com', path: '/' } },
      { cookie: { name: 'seven', domain: 'sliccy.ai', path: '/' } },
      { cookieUrl: `${STAGE}/ims/check` },
      { cookieUrl: 'https://www.sliccy.ai/api' },
      { cookieUrl: 'not a url', rawCookieLine: `a=${SECRET}` },
      { rawCookieLine: `host=${SECRET}; Domain=adobelogin.com; Path=/` },
      { rawCookieLine: `seven=${SECRET}; domain=.sliccy.ai; Path=/; SameSite=Lax` },
      { rawCookieLine: `nowhere=${SECRET}; Path=/` },
      { rawCookieLine: `${SECRET}`, cookieUrl: `${IDP}/x` },
    ];
    const kept = [
      { rawCookieLine: 'plain=visible; Domain=ordinary.example' },
      { rawCookieLine: 'plain=visible', cookieUrl: `${ORDINARY}/api` },
      { cookie: { name: 'plain', domain: 'x.ims-na1.adobelogin.com', path: '/' } },
      { cookieUrl: 'https://ims-na1.adobelogin.com.evil.example/', rawCookieLine: 'plain=visible' },
      {},
    ];
    const mark = wire.delivered.length;
    for (const details of [...dropped, ...kept])
      wire.emit({
        method: 'Audits.issueAdded',
        sessionId: session,
        params: {
          issue: { code: 'CookieIssue', details: { cookieIssueDetails: { ...base, ...details } } },
        },
      });
    for (let turn = 0; turn < 40; turn += 1) await flush();
    const seen = wire.delivered
      .slice(mark)
      .filter((message) => message.method === 'Audits.issueAdded');
    assert.ok(!JSON.stringify(seen).includes(SECRET), JSON.stringify(seen));
    assert.equal(seen.length, kept.length);
  });

  test(`a request to an Adobe login host loses their cookie headers on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    wire.target('plain', 'page', { id: 'plain', url: `${ORDINARY}/`, securityOrigin: ORDINARY });
    const session = await wire.attach('plain');
    await wire.send('Network.enable', {}, session);
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: session,
      params: {
        requestId: 'adobe-1',
        loaderId: 'loader',
        documentURL: `${ORDINARY}/`,
        frameId: 'plain',
        type: 'XHR',
        request: { url: `${LOGIN}/signin/v2`, method: 'GET', headers: {} },
      },
    });
    wire.emit({
      method: 'Network.requestWillBeSentExtraInfo',
      sessionId: session,
      params: {
        requestId: 'adobe-1',
        associatedCookies: [
          { cookie: { name: 'adobe', value: SECRET, domain: '.adobe.com' }, blockedReasons: [] },
        ],
        headers: { Cookie: `adobe=${SECRET}`, Accept: '*/*' },
      },
    });
    for (let turn = 0; turn < 40; turn += 1) await flush();
    const seen = wire.delivered.slice(mark);
    assert.ok(!JSON.stringify(seen).includes(SECRET));
    const extra = seen.find((message) => message.method === 'Network.requestWillBeSentExtraInfo');
    assert.deepEqual(extra?.params.headers, { Accept: '*/*' });
  });

  test(`a request the guard has forgotten keeps no cookie headers on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    wire.target('plain', 'page', { id: 'plain', url: `${ORDINARY}/`, securityOrigin: ORDINARY });
    const session = await wire.attach('plain');
    await wire.send('Network.enable', {}, session);
    const mark = wire.delivered.length;
    for (let index = 0; index <= 10000; index += 1)
      wire.emit({
        method: 'Network.webSocketCreated',
        sessionId: session,
        params: { requestId: `socket-${index}`, url: `wss://ordinary.example/${index}` },
      });
    wire.emit({
      method: 'Network.webSocketWillSendHandshakeRequest',
      sessionId: session,
      params: {
        requestId: 'socket-0',
        timestamp: 1,
        wallTime: 1,
        request: { headers: { Cookie: `plain=${SECRET}`, Upgrade: 'websocket' } },
      },
    });
    for (let turn = 0; turn < 40; turn += 1) await flush();
    const seen = wire.delivered.slice(mark);
    assert.ok(seen.length > 10000);
    assert.ok(!JSON.stringify(seen).includes(SECRET));
  });

  test(`Fetch pauses of credential requests lose their cookie headers on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const session = await idpPage(wire);
    await wire.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Fetch.requestPaused',
      sessionId: session,
      params: {
        requestId: 'interception-1',
        networkId: 'idp-net-1',
        frameId: 'idp',
        resourceType: 'XHR',
        request: { url: `${IDP}/ims/check`, method: 'GET', headers: { Cookie: `p=${SECRET}` } },
        responseStatusCode: 200,
        responseHeaders: [
          { name: 'Set-Cookie', value: `host=${SECRET}` },
          { name: 'Content-Type', value: 'text/html' },
        ],
      },
    });
    for (let turn = 0; turn < 40; turn += 1) await flush();
    const paused = wire.delivered
      .slice(mark)
      .find((message) => message.method === 'Fetch.requestPaused');
    assert.ok(paused, 'the pause reaches the client');
    assert.deepEqual(paused.params.request.headers, {});
    assert.deepEqual(paused.params.responseHeaders, [{ name: 'Content-Type', value: 'text/html' }]);
  });

  test(`ordinary requests keep their cookie headers on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    wire.target('plain', 'page', { id: 'plain', url: `${ORDINARY}/`, securityOrigin: ORDINARY });
    const session = await wire.attach('plain');
    await wire.send('Network.enable', {}, session);
    const mark = wire.delivered.length;
    const emit = (method, params) => wire.emit({ method, sessionId: session, params });
    emit('Network.requestWillBeSent', {
      requestId: 'plain-1',
      loaderId: 'loader',
      documentURL: `${ORDINARY}/`,
      frameId: 'plain',
      type: 'XHR',
      request: { url: `${ORDINARY}/api`, method: 'GET', headers: {} },
    });
    emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'plain-1',
      associatedCookies: [
        {
          cookie: { name: 'plain', value: 'visible', domain: 'ordinary.example' },
          blockedReasons: [],
        },
        {
          cookie: { name: 'parent', value: SECRET, domain: '.adobelogin.com' },
          blockedReasons: [],
        },
      ],
      headers: { Cookie: 'plain=visible' },
    });
    emit('Network.responseReceivedExtraInfo', {
      requestId: 'plain-1',
      statusCode: 200,
      headers: { 'set-cookie': 'plain=visible' },
      headersText: 'HTTP/1.1 200 OK\nSet-Cookie: plain=visible\n',
    });
    emit('Audits.issueAdded', {
      issue: {
        code: 'CookieIssue',
        details: {
          cookieIssueDetails: {
            rawCookieLine: 'plain=visible',
            cookieWarningReasons: [],
            cookieExclusionReasons: [],
            operation: 'SetCookie',
            cookieUrl: `${ORDINARY}/api`,
            request: { requestId: 'plain-1' },
          },
        },
      },
    });
    for (let turn = 0; turn < 40; turn += 1) await flush();
    const seen = wire.delivered.slice(mark);
    assert.ok(!JSON.stringify(seen).includes(SECRET));
    const extra = seen.find((message) => message.method === 'Network.requestWillBeSentExtraInfo');
    assert.deepEqual(extra?.params.headers, { Cookie: 'plain=visible' });
    assert.deepEqual(
      extra?.params.associatedCookies.map((entry) => entry.cookie.name),
      ['plain']
    );
    const response = seen.find((message) => message.method === 'Network.responseReceivedExtraInfo');
    assert.deepEqual(response?.params.headers, { 'set-cookie': 'plain=visible' });
    assert.equal(response?.params.headersText, 'HTTP/1.1 200 OK\nSet-Cookie: plain=visible\n');
    const issue = seen.find((message) => message.method === 'Audits.issueAdded');
    assert.equal(issue?.params.issue.details.cookieIssueDetails.rawCookieLine, 'plain=visible');
  });

  test(`a credential-origin page stays drivable on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const session = await idpPage(wire);
    const listing = await answered(wire, 'Target.getTargets', {}, undefined, {
      targetInfos: [{ targetId: 'idp', type: 'page', url: PAGE, title: 'Sign in', attached: true }],
    });
    assert.equal(listing.error, undefined);
    assert.deepEqual(
      listing.result.targetInfos.map((info) => info.url),
      [PAGE]
    );
    await passed(wire, 'Page.enable', {}, session);
    await passed(wire, 'Runtime.enable', {}, session);
    const evaluated = await passed(
      wire,
      'Runtime.evaluate',
      { expression: 'document.title', returnByValue: true },
      session
    );
    assert.ok(evaluated.result.result);
    await passed(wire, 'DOM.getDocument', { depth: 1 }, session);
    await passed(
      wire,
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 },
      session
    );
    await passed(
      wire,
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 },
      session
    );
    await passed(wire, 'Input.insertText', { text: 'person@example.test' }, session);
    await passed(wire, 'Page.captureScreenshot', {}, session);
    await passed(wire, 'Page.navigate', { url: `${STAGE}/ims/login` }, session);
  });

  test(`seven's own cookie filter is unchanged on the ${label} route`, async (t) => {
    const wire = wired(t, route);
    const own = [
      { name: 'own', value: SECRET, domain: 'protected.invalid', path: '/' },
      { name: 'seven', value: SECRET, domain: '.sliccy.ai', path: '/' },
      { name: 'vault', value: SECRET, domain: 'vault.sliccy.ai', path: '/' },
      {
        name: 'under-seven',
        value: SECRET,
        domain: 'ordinary.example',
        path: '/',
        partitionKey: { topLevelSite: 'https://sliccy.ai', hasCrossSiteAncestor: true },
      },
    ];
    const answer = await answered(wire, 'Network.getAllCookies', {}, undefined, {
      cookies: [...own, ...keptCookies],
    });
    assert.deepEqual(
      names(answer),
      keptCookies.map((cookie) => cookie.name)
    );
    await refused(
      wire,
      'Network.setCookie',
      { name: 'x', value: 'y', url: 'https://protected.invalid/' },
      undefined,
      PROTECTED
    );
    await refused(
      wire,
      'Network.setCookie',
      { name: 'x', value: 'y', url: `${IDP}/`, domain: 'sliccy.ai' },
      undefined,
      PROTECTED
    );
    await refused(
      wire,
      'DOMStorage.getDOMStorageItems',
      { storageId: { securityOrigin: 'https://vault.sliccy.ai', isLocalStorage: true } },
      undefined,
      PROTECTED
    );
  });
}
