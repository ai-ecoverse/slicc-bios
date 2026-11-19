import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected, PROTECTED } = await import(
  process.env.GUARD_SOURCE ?? '../../src/seed/guard.js'
);

const ORDINARY = 'https://ordinary.example/doc';
const BOUNCE = 'https://ordinary.example/bounce';
const SEVEN = 'https://www.sliccy.ai/landing';
const VAULT = 'https://vault.sliccy.ai/landing';
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

const location = (value) => ({ responseHeaders: [{ name: 'Location', value }] });
const redirects = [
  ['a 302 with an absolute Location to seven', 'Request', 302, location(SEVEN), SEVEN],
  [
    'a 301 with a protocol-relative Location to the vault',
    'Request',
    301,
    location('//vault.sliccy.ai/landing'),
    VAULT,
  ],
  [
    'a 307 with a binary Location to seven',
    'Request',
    307,
    { binaryResponseHeaders: binary(`Location: ${SEVEN}`) },
    SEVEN,
  ],
  [
    'a 302 continueResponse with an absolute Location to the vault',
    'Response',
    302,
    location(VAULT),
    VAULT,
  ],
  [
    'a 303 at the response stage with a protocol-relative Location to seven',
    'Response',
    303,
    location('//www.sliccy.ai/landing'),
    SEVEN,
  ],
];

const chosen = [
  ['Cookie', 'probe=1'],
  ['Authorization', 'Bearer probe'],
  ['Host', 'www.sliccy.ai'],
];
const headed = (names) => ({
  headers: chosen
    .filter(([name]) => names.includes(name))
    .map(([name, value]) => ({ name, value })),
});
const overrides = [
  ['a Cookie header to seven', { url: SEVEN, ...headed(['Cookie']) }],
  ['an Authorization header to the vault', { url: VAULT, ...headed(['Authorization']) }],
  ['a Host header to seven', { url: SEVEN, ...headed(['Host']) }],
  ['a method and postData to the vault', { url: VAULT, method: 'POST', postData: binary('probe') }],
  [
    'headers, method and postData to seven',
    {
      url: SEVEN,
      method: 'PUT',
      postData: binary('probe'),
      ...headed(['Cookie', 'Authorization']),
    },
  ],
];

const frames = async () => [];

async function setup(t, route, caller) {
  const wire = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), route, frames, caller)
  );
  wire.target('page');
  const session = await wire.attach('page');
  let next = 0;
  const pause = async (params) => {
    const requestId = params.requestId ?? `interception-${++next}`;
    const mark = wire.delivered.length;
    const sent = wire.sent.length;
    wire.emit({
      method: 'Fetch.requestPaused',
      sessionId: session,
      params: { frameId: 'page', ...params, requestId },
    });
    for (let turn = 0; turn < 20; turn += 1) await flush();
    const offered = wire.delivered
      .slice(mark)
      .some(
        (event) => event.method === 'Fetch.requestPaused' && event.params.requestId === requestId
      );
    const answered = wire.sent
      .slice(sent)
      .filter((message) => message.id >= 2 ** 30 && message.params?.requestId === requestId)
      .map(({ method, params }) => ({ method, params }));
    return { requestId, offered, answered };
  };
  const write = async (method, params) => {
    const mark = wire.sent.length;
    const answer = await wire.send(method, params, session);
    const sent = wire.clients(mark).filter((message) => message.method === method);
    return { answer, sent: sent.map((message) => message.params) };
  };
  return { pause, write };
}

const observed = (label, row) => console.log(`ROW-OBSERVED node ${label} ${JSON.stringify(row)}`);

for (const [label, route, caller] of routes) {
  for (const [shape, stage, code, headers, landing] of redirects) {
    test(`a Document hop after ${shape} is failed, not offered, on the ${label} route`, async (t) => {
      const wire = await setup(t, route, caller);
      const first = await wire.pause({
        resourceType: 'Document',
        request: { url: ORDINARY, method: 'GET', headers: {} },
        ...(stage === 'Response' ? { responseStatusCode: 200, responseHeaders: [] } : {}),
      });
      assert.ok(first.offered, 'the ordinary Document pause is offered');
      const method =
        stage === 'Response' && code === 302 ? 'Fetch.continueResponse' : 'Fetch.fulfillRequest';
      const written = await wire.write(method, {
        requestId: first.requestId,
        responseCode: code,
        ...headers,
      });
      const hop = await wire.pause({
        requestId: `${first.requestId}.hop`,
        redirectedRequestId: first.requestId,
        resourceType: 'Document',
        request: { url: landing, method: 'GET', headers: {} },
      });
      observed(label, {
        shape,
        write: written.answer.error?.message ?? 'forwarded',
        hopOffered: hop.offered,
        hopAnswer: hop.answered,
      });
      assert.equal(hop.offered, false, 'the protected hop is not offered');
      assert.deepEqual(
        hop.answered.map(({ method, params }) => [method, params.errorReason]),
        [['Fetch.failRequest', 'BlockedByClient']],
        'the protected Document hop is failed'
      );
    });
  }

  for (const [shape, params] of overrides) {
    test(`continueRequest with ${shape} is refused on the ${label} route`, async (t) => {
      const wire = await setup(t, route, caller);
      const { requestId, offered } = await wire.pause({
        resourceType: 'XHR',
        request: { url: ORDINARY, method: 'GET', headers: {} },
      });
      assert.ok(offered);
      const { answer, sent } = await wire.write('Fetch.continueRequest', { requestId, ...params });
      observed(label, { shape, answer: answer.error?.message ?? 'forwarded', sent });
      assert.equal(answer.error?.message, PROTECTED, `${shape} was answered`);
      assert.deepEqual(sent, [], `${shape} reached the browser`);
    });
  }

  for (const resourceType of ['XHR', 'Document']) {
    test(`a ${resourceType} hop into seven after a continueRequest with chosen headers is released bare on the ${label} route`, async (t) => {
      const wire = await setup(t, route, caller);
      const first = await wire.pause({
        resourceType,
        request: { url: ORDINARY, method: 'GET', headers: {} },
      });
      assert.ok(first.offered);
      const written = await wire.write('Fetch.continueRequest', {
        requestId: first.requestId,
        url: BOUNCE,
        method: 'POST',
        postData: binary('probe'),
        ...headed(['Cookie', 'Authorization']),
      });
      const hop = await wire.pause({
        requestId: `${first.requestId}.hop`,
        redirectedRequestId: first.requestId,
        resourceType,
        request: {
          url: SEVEN,
          method: 'POST',
          headers: { Cookie: 'probe=1', Authorization: 'Bearer probe' },
        },
      });
      const late = await wire.write('Fetch.continueRequest', {
        requestId: hop.requestId,
        ...headed(['Cookie', 'Authorization']),
      });
      observed(label, {
        resourceType,
        write: written.answer.error?.message ?? 'forwarded',
        hopOffered: hop.offered,
        hopAnswer: hop.answered,
        late: late.answer.error?.message ?? 'forwarded',
      });
      assert.equal(hop.offered, false, 'the protected hop is not offered');
      assert.deepEqual(late.sent, [], 'a write on the protected hop does not reach the browser');
      for (const { method, params } of hop.answered) {
        assert.equal(params.headers, undefined, `${method} carries no headers`);
        assert.equal(params.postData, undefined, `${method} carries no postData`);
        assert.equal(params.method, undefined, `${method} carries no method`);
        assert.equal(params.url, undefined, `${method} carries no url`);
      }
      assert.equal(hop.answered.length, 1, 'the guard answers the hop once');
    });
  }
}
