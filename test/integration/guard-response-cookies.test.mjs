import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected, PROTECTED } = await import(
  process.env.GUARD_SOURCE ?? '../../src/seed/guard.js'
);

const ORDINARY = 'https://ordinary.example/api';
const SEVEN = 'https://www.sliccy.ai/home';
const VAULT = 'https://vault.sliccy.ai/secrets';
const OWN = 'https://protected.invalid/page';
const PLANTED = 'sid=PLANTED; Domain=.sliccy.ai; Path=/; HttpOnly';
const binary = (text) => Buffer.from(text, 'latin1').toString('base64');

const routes = [
  ['devtools', undefined, undefined],
  ['link', { kind: 'link', version: '1.60.0' }, undefined],
  ['extension', { kind: 'extension', version: '7.12.0' }, undefined],
  [
    'device caller',
    { kind: 'link', version: '1.60.0' },
    { kind: 'device', id: 'd', name: 'phone' },
  ],
];
const writes = [
  ['Fetch.fulfillRequest', { responseCode: 200 }],
  ['Fetch.continueResponse', { responseCode: 200 }],
];

const frames = async () => [];
const wired = (t, route, caller) =>
  protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route, frames, caller));

const cookie = (value, name = 'Set-Cookie') => ({ responseHeaders: [{ name, value }] });

const planted = [
  ['Domain=.sliccy.ai', cookie(PLANTED)],
  ['Domain=vault.sliccy.ai', cookie('sid=PLANTED; Domain=vault.sliccy.ai')],
  ['the guard’s own origin', cookie('sid=PLANTED; Domain=protected.invalid')],
  ['a lowercase set-cookie name', cookie(PLANTED, 'set-cookie')],
  ['a Set-Cookie2 name in any case', cookie(PLANTED, 'SET-COOKIE2')],
  ['a double-quoted Domain', cookie('sid=PLANTED; Domain="sliccy.ai"')],
  ['a single-quoted Domain', cookie("sid=PLANTED; Domain='vault.sliccy.ai'")],
  ['an upper-case Domain with a trailing dot', cookie('sid=PLANTED; DOMAIN = SLICCY.AI.')],
  ['a repeated Domain', cookie('sid=PLANTED; Domain=ordinary.example; domain=.sliccy.ai')],
  ['a second line joined by LF', cookie(`plain=1; Domain=ordinary.example\n${PLANTED}`)],
  ['a second line joined by CRLF', cookie(`plain=1\r\n${PLANTED}`)],
  ['a bare Domain on its own line', cookie('plain=1\nDomain=.sliccy.ai')],
  [
    'a second array entry',
    {
      responseHeaders: [
        { name: 'Set-Cookie', value: 'plain=1; Domain=ordinary.example' },
        { name: 'Set-Cookie', value: PLANTED },
      ],
    },
  ],
  ['an object map', { responseHeaders: { 'Content-Type': 'text/html', 'Set-Cookie': PLANTED } }],
  ['an object map in mixed case', { responseHeaders: { 'sEt-CoOkIe': PLANTED } }],
  [
    'binary headers joined by CRLF',
    { binaryResponseHeaders: binary(`Set-Cookie: ${PLANTED}\r\n`) },
  ],
  [
    'binary headers joined by NUL',
    { binaryResponseHeaders: binary(`Content-Type: text/html\0set-cookie: ${PLANTED}`) },
  ],
  [
    'binary headers beside ordinary responseHeaders',
    {
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      binaryResponseHeaders: binary(`Set-Cookie2: ${PLANTED}\n`),
    },
  ],
];

const phrased = [
  [
    'a phrase with CRLF and a protected cookie',
    { responsePhrase: `OK\r\n${'Set-Cookie: '}${PLANTED}` },
  ],
  [
    'a phrase with CRLF and an ordinary cookie',
    { responsePhrase: 'OK\r\nSet-Cookie: sid=1; Domain=ordinary.example' },
  ],
  [
    'a phrase with CRLF and a credential cookie',
    { responsePhrase: 'OK\r\nSet-Cookie: sid=1; Domain=.adobelogin.com; HttpOnly' },
  ],
  ['a phrase with a lone LF', { responsePhrase: 'OK\nX-A: b' }],
  ['a phrase with a lone CR', { responsePhrase: 'OK\rX-A: b' }],
  ['a phrase with a NUL', { responsePhrase: 'OK\0' }],
  ['a phrase that names a protected Domain', { responsePhrase: `OK Set-Cookie: ${PLANTED}` }],
  ['a phrase whose Domain is not a host', { responsePhrase: 'OK x: a; Domain="sliccy.ai' }],
  ['a phrase that is not a string', { responsePhrase: 7 }],
  ['a status code that is not an integer', { responseCode: '200 OK' }],
];

const unparsed = [
  ['responseHeaders as a string', { responseHeaders: `Set-Cookie: ${PLANTED}` }],
  ['responseHeaders as null', { responseHeaders: null }],
  ['a null header entry', { responseHeaders: [null] }],
  ['a header entry without a name', { responseHeaders: [{ value: PLANTED }] }],
  ['a numeric cookie value', { responseHeaders: [{ name: 'Set-Cookie', value: 7 }] }],
  ['a list as a map value', { responseHeaders: { 'Set-Cookie': [PLANTED] } }],
  ['a header name that is not a token', cookie(PLANTED, 'Set-Cookie ')],
  [
    'a line break in another header',
    { responseHeaders: { 'X-Note': `a\r\nSet-Cookie: ${PLANTED}` } },
  ],
  ['a Domain with an unbalanced quote', cookie('sid=PLANTED; Domain="sliccy.ai')],
  ['an empty Domain', cookie('sid=PLANTED; Domain=')],
  ['binary headers that are not base64', { binaryResponseHeaders: '!!not base64!!' }],
  ['binary headers with bad padding', { binaryResponseHeaders: 'U2V0=' }],
  ['binary headers as a number', { binaryResponseHeaders: 7 }],
  [
    'a binary line without a colon',
    { binaryResponseHeaders: binary(`Set-Cookie: plain=1\n${PLANTED}`) },
  ],
  [
    'a folded binary line',
    { binaryResponseHeaders: binary(`Set-Cookie: plain=1\n x: ${PLANTED}`) },
  ],
];

const ordinary = [
  ['Domain=ordinary.example', cookie('sid=1; Domain=ordinary.example; Path=/')],
  ['Domain=.adobe.com', cookie('sid=1; Domain=.adobe.com; Secure')],
  ['a host-only line', cookie('sid=1; Path=/; HttpOnly')],
  ['a body-only response', { body: 'aGVsbG8=' }],
  ['a non-cookie header', { responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }] }],
  [
    'an ordinary object map',
    { responseHeaders: { 'set-cookie': 'a=1\nb=2; Domain=ordinary.example' } },
  ],
  [
    'ordinary binary headers',
    { binaryResponseHeaders: binary('Set-Cookie: a=1\r\nX-A: b\r\n\r\n') },
  ],
  ['an empty header list', { responseHeaders: [] }],
  ['the phrase OK', { responsePhrase: 'OK' }],
  ['the phrase Not Found', { responseCode: 404, responsePhrase: 'Not Found' }],
  ['an empty phrase', { responsePhrase: '' }],
  ['a long phrase', { responsePhrase: 'Ordinary '.repeat(500).trim() }],
  ['a phrase with an ordinary colon', { responsePhrase: 'Moved: see Location' }],
];

async function setup(t, route, caller) {
  const wire = wired(t, route, caller);
  wire.target('page');
  const session = await wire.attach('page');
  let next = 0;
  const pause = async (url = ORDINARY) => {
    const requestId = `interception-${++next}`;
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Fetch.requestPaused',
      sessionId: session,
      params: {
        requestId,
        request: { url, method: 'GET', headers: {} },
        resourceType: 'XHR',
        responseStatusCode: 200,
        responseHeaders: [],
      },
    });
    for (let turn = 0; turn < 20; turn += 1) await flush();
    const offered = wire.delivered
      .slice(mark)
      .some(
        (event) => event.method === 'Fetch.requestPaused' && event.params.requestId === requestId
      );
    return { requestId, offered };
  };
  const write = async (method, params) => {
    const mark = wire.sent.length;
    const answer = await wire.send(method, params, session);
    const sent = wire.clients(mark).filter((message) => message.method === method);
    return { answer, sent };
  };
  return { pause, write };
}

async function refused(setup, method, params, url) {
  const { requestId, offered } = await setup.pause(url);
  const { answer, sent } = await setup.write(method, { requestId, ...params });
  assert.equal(
    answer.error?.message,
    PROTECTED,
    `${method} ${JSON.stringify(params)} was answered`
  );
  assert.equal(answer.result, undefined);
  assert.deepEqual(sent, [], `${method} ${JSON.stringify(params)} reached the browser`);
  return { requestId, offered };
}

async function passed(setup, method, params) {
  const { requestId, offered } = await setup.pause();
  assert.ok(offered, 'the ordinary pause is offered');
  const { answer, sent } = await setup.write(method, { requestId, ...params });
  assert.equal(answer.error, undefined, `${method} ${JSON.stringify(params)} was refused`);
  assert.deepEqual(
    sent.map((message) => message.params),
    [{ requestId, ...params }]
  );
}

for (const [label, route, caller] of routes) {
  for (const [method, base] of writes) {
    for (const [shape, params] of planted) {
      test(`${method} refuses ${shape} on the ${label} route`, async (t) => {
        await refused(await setup(t, route, caller), method, { ...base, ...params });
      });
    }

    for (const [shape, params] of phrased) {
      test(`${method} refuses ${shape} on the ${label} route`, async (t) => {
        const wire = await setup(t, route, caller);
        const { requestId } = await refused(wire, method, { ...base, ...params });
        const clean = await wire.write(method, { requestId, ...base });
        assert.equal(clean.answer.error, undefined, 'the pause stays offered');
        assert.deepEqual(
          clean.sent.map((message) => message.params),
          [{ requestId, ...base }]
        );
      });
    }

    for (const [shape, params] of unparsed) {
      test(`${method} refuses ${shape} on the ${label} route`, async (t) => {
        await refused(await setup(t, route, caller), method, { ...base, ...params });
      });
    }

    for (const url of [SEVEN, VAULT, OWN]) {
      test(`${method} refuses a pause for ${url} on the ${label} route`, async (t) => {
        const wire = await setup(t, route, caller);
        for (const params of [{}, cookie('sid=1; Path=/'), cookie(PLANTED)]) {
          const { offered } = await refused(wire, method, { ...base, ...params }, url);
          assert.equal(offered, false, `${url} was offered`);
        }
      });
    }

    for (const [shape, params] of ordinary) {
      test(`${method} forwards ${shape} unchanged on the ${label} route`, async (t) => {
        await passed(await setup(t, route, caller), method, { ...base, ...params });
      });
    }

    test(`${method} forwards a bare request id unchanged on the ${label} route`, async (t) => {
      await passed(await setup(t, route, caller), method, {});
    });
  }

  test(`a refused write leaves the pause for a clean answer on the ${label} route`, async (t) => {
    const wire = await setup(t, route, caller);
    const { requestId } = await wire.pause();
    const planting = await wire.write('Fetch.fulfillRequest', { requestId, ...cookie(PLANTED) });
    assert.equal(planting.answer.error?.message, PROTECTED);
    const clean = await wire.write('Fetch.continueResponse', { requestId });
    assert.equal(clean.answer.error, undefined);
    assert.deepEqual(
      clean.sent.map((message) => message.params),
      [{ requestId }]
    );
  });

  test(`a redirect keeps its Location unchanged on the ${label} route`, async (t) => {
    const wire = await setup(t, route, caller);
    const location = { name: 'Location', value: SEVEN };
    await passed(wire, 'Fetch.fulfillRequest', { responseCode: 302, responseHeaders: [location] });
    await passed(wire, 'Fetch.continueResponse', {
      responseCode: 302,
      responseHeaders: [location, { name: 'Set-Cookie', value: 'sid=1; Domain=ordinary.example' }],
    });
  });

  for (const method of ['Fetch.fulfillRequest', 'Fetch.continueResponse']) {
    test(`${method} refuses a redirect that plants a cookie on the ${label} route`, async (t) => {
      await refused(await setup(t, route, caller), method, {
        responseCode: 302,
        responseHeaders: [
          { name: 'Location', value: SEVEN },
          { name: 'Set-Cookie', value: PLANTED },
        ],
      });
    });
  }
}

test('every row names its shape', () => {
  for (const rows of [planted, phrased, unparsed, ordinary]) {
    const names = rows.map(([name]) => name);
    assert.equal(new Set(names).size, names.length);
  }
});
