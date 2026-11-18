import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected, INTERCEPTION } = await import(
  process.env.GUARD_SOURCE ?? '../../src/seed/guard.js'
);

const ROUTES = [
  ['devtools', undefined, undefined],
  ['link', { kind: 'link', version: '1.60.0' }, undefined],
  ['extension', { kind: 'extension', version: '7.12.0' }, undefined],
  ['device', undefined, { kind: 'device', id: 'device-1', name: 'phone' }],
];
const COMMANDS = [
  ['Network.setRequestInterception', { patterns: [{ urlPattern: '*' }] }],
  [
    'Network.continueInterceptedRequest',
    {
      interceptionId: 'interception-1',
      headers: { 'Set-Cookie': 'sid=PLANTED; Domain=.sliccy.ai; HttpOnly' },
    },
  ],
  ['Network.getResponseBodyForInterception', { interceptionId: 'interception-1' }],
  ['Network.takeResponseBodyForInterceptionAsStream', { interceptionId: 'interception-1' }],
];
const PROTECTED = [
  `${protectedOrigin}/page`,
  'https://www.sliccy.ai/home',
  'https://vault.sliccy.ai/secrets',
  'https://ordinary.invalid/page?client_id=experience-catalyst-prod',
];

async function open(t, route, caller) {
  const wire = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), route, async () => null, caller)
  );
  wire.target('ordinary');
  const session = await wire.attach('ordinary');
  return { wire, session };
}

const intercepted = (session, interceptionId, url, extra = {}) => ({
  method: 'Network.requestIntercepted',
  sessionId: session,
  params: {
    interceptionId,
    frameId: 'ordinary',
    resourceType: 'XHR',
    isNavigationRequest: false,
    request: { url, method: 'GET', headers: {} },
    ...extra,
  },
});

const shown = (wire, id) =>
  wire.delivered.some(
    (message) =>
      message.method === 'Network.requestIntercepted' && message.params?.interceptionId === id
  );
const continued = (wire, id) =>
  wire.sent.filter(
    (message) =>
      message.method === 'Network.continueInterceptedRequest' &&
      message.params?.interceptionId === id
  );

for (const [name, route, caller] of ROUTES) {
  for (const [method, params] of COMMANDS) {
    test(`${name}: ${method} is refused before Chrome`, { timeout: 5000 }, async (t) => {
      const { wire, session } = await open(t, route, caller);
      const answer = await wire.send(method, params, session);
      assert.equal(answer.error?.message, INTERCEPTION);
      assert.match(answer.error.message, /Fetch instead/);
      assert.equal(
        wire.sent.some((message) => message.method === method),
        false
      );
    });
  }

  test(`${name}: a protected requestIntercepted is released, not delivered`, {
    timeout: 5000,
  }, async (t) => {
    const { wire, session } = await open(t, route, caller);
    for (const [index, url] of PROTECTED.entries()) {
      wire.emit(intercepted(session, `protected-${index}`, url));
      await flush();
      await flush();
      assert.equal(shown(wire, `protected-${index}`), false, url);
      assert.deepEqual(
        continued(wire, `protected-${index}`).map((message) => message.params),
        [{ interceptionId: `protected-${index}` }],
        url
      );
    }
  });

  test(`${name}: a protected document, redirect, challenge and marked request stay in the guard`, {
    timeout: 5000,
  }, async (t) => {
    const { wire, session } = await open(t, route, caller);
    wire.emit(
      intercepted(session, 'document', 'https://www.sliccy.ai/home', {
        resourceType: 'Document',
        isNavigationRequest: true,
      })
    );
    wire.emit(
      intercepted(session, 'redirect', ordinary, { redirectUrl: 'https://vault.sliccy.ai/x' })
    );
    wire.emit(
      intercepted(session, 'challenge', 'https://vault.sliccy.ai/secrets', {
        authChallenge: { source: 'Server', origin: 'https://vault.sliccy.ai', scheme: 'basic' },
      })
    );
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: session,
      params: {
        requestId: 'marked',
        loaderId: 'loader',
        documentURL: ordinary,
        request: { url: 'https://vault.sliccy.ai/secrets', method: 'GET', headers: {} },
        type: 'XHR',
        frameId: 'ordinary',
      },
    });
    await flush();
    await flush();
    wire.emit(intercepted(session, 'marked', ordinary, { requestId: 'marked' }));
    for (let i = 0; i < 4; i += 1) await flush();
    for (const id of ['document', 'redirect', 'challenge', 'marked'])
      assert.equal(shown(wire, id), false, id);
    assert.deepEqual(continued(wire, 'document')[0].params, {
      interceptionId: 'document',
      errorReason: 'BlockedByClient',
    });
    assert.deepEqual(continued(wire, 'redirect')[0].params, { interceptionId: 'redirect' });
    assert.deepEqual(continued(wire, 'challenge')[0].params, {
      interceptionId: 'challenge',
      authChallengeResponse: { response: 'Default' },
    });
    assert.deepEqual(continued(wire, 'marked')[0].params, { interceptionId: 'marked' });
  });

  test(`${name}: an ordinary requestIntercepted is delivered`, { timeout: 5000 }, async (t) => {
    const { wire, session } = await open(t, route, caller);
    wire.emit(intercepted(session, 'plain', ordinary));
    wire.emit({
      method: 'Network.requestWillBeSent',
      sessionId: session,
      params: {
        requestId: 'seen',
        loaderId: 'loader',
        documentURL: ordinary,
        request: { url: ordinary, method: 'GET', headers: {} },
        type: 'XHR',
        frameId: 'ordinary',
      },
    });
    await flush();
    await flush();
    wire.emit(intercepted(session, 'tracked', ordinary, { requestId: 'seen' }));
    for (let i = 0; i < 4; i += 1) await flush();
    assert.equal(shown(wire, 'plain'), true);
    assert.equal(shown(wire, 'tracked'), true);
    assert.deepEqual(continued(wire, 'plain'), []);
    assert.deepEqual(continued(wire, 'tracked'), []);
  });

  test(`${name}: the Fetch interception path is unchanged`, { timeout: 5000 }, async (t) => {
    const { wire, session } = await open(t, route, caller);
    const pause = (requestId, url) => ({
      method: 'Fetch.requestPaused',
      sessionId: session,
      params: {
        requestId,
        frameId: 'ordinary',
        resourceType: 'XHR',
        request: { url, method: 'GET', headers: {} },
      },
    });
    wire.emit(pause('fetch-plain', ordinary));
    wire.emit(pause('fetch-vault', 'https://vault.sliccy.ai/secrets'));
    for (let i = 0; i < 4; i += 1) await flush();
    const paused = (id) =>
      wire.delivered.some(
        (message) => message.method === 'Fetch.requestPaused' && message.params?.requestId === id
      );
    assert.equal(paused('fetch-plain'), true);
    assert.equal(paused('fetch-vault'), false);
    assert.ok(
      wire.sent.some(
        (message) =>
          message.method === 'Fetch.continueRequest' &&
          JSON.stringify(message.params) === JSON.stringify({ requestId: 'fetch-vault' })
      )
    );
    const answer = await wire.send('Fetch.continueRequest', { requestId: 'fetch-plain' }, session);
    assert.equal(answer.error, undefined);
    assert.ok(
      wire
        .clients()
        .some(
          (message) =>
            message.method === 'Fetch.continueRequest' && message.params.requestId === 'fetch-plain'
        )
    );
  });
}
