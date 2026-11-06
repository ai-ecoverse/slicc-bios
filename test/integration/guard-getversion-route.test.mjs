import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHook } from '../../src/seed/cdp.js';
import { guardProtected } from '../../src/seed/guard.js';
import { flush, protocol } from './guard-state-fixture.mjs';

const chrome = {
  product: 'Chrome/154.0.8037.98',
  protocolVersion: '1.3',
  revision: '@abc',
  userAgent: 'Mozilla/5.0 Fake',
  jsVersion: '13.4.114',
};

const routes = [
  ['extension', { kind: 'extension', version: '7.12.0' }, 'extension'],
  ['link', { kind: 'link', version: '1.60.0' }, 'link'],
  ['devtools', undefined, 'devtools'],
];

function versionWire(t, route) {
  return protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route));
}

async function getVersion(wire, payload) {
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Browser.getVersion');
  const read = wire.request('Browser.getVersion');
  await flush();
  const held = wire.held.find((message) => message.id === read.id);
  assert.ok(held);
  wire.release(held, payload);
  return read.answer;
}

for (const [label, route, expected] of routes) {
  test(`Browser.getVersion adds slicc.route on the ${label} route`, async (t) => {
    const wire = versionWire(t, route);
    const answer = await getVersion(wire, { result: { ...chrome } });
    assert.equal(answer.error, undefined);
    assert.deepEqual(answer.result, { ...chrome, slicc: { route: expected } });
  });

  test(`Browser.getVersion strips an inbound slicc spoof on the ${label} route`, async (t) => {
    const wire = versionWire(t, route);
    const answer = await getVersion(wire, {
      result: { ...chrome, slicc: { route: 'spoof', attacker: true } },
    });
    assert.equal(answer.error, undefined);
    assert.deepEqual(answer.result, { ...chrome, slicc: { route: expected } });
    assert.equal(Object.hasOwn(answer.result.slicc, 'attacker'), false);
  });
}

test('Browser.getVersion leaves an error answer untouched', async (t) => {
  const wire = versionWire(t, { kind: 'link', version: '1.60.0' });
  const error = { code: -32000, message: 'Browser.getVersion failed upstream' };
  const answer = await getVersion(wire, { error });
  assert.equal(answer.result, undefined);
  assert.deepEqual(answer.error, error);
  assert.equal(Object.hasOwn(answer, 'slicc'), false);
});

for (const [kind, result] of [
  ['null', null],
  ['string', 'Chrome/synthetic'],
  ['number', 42],
  ['array', ['Chrome/synthetic']],
]) {
  test(`Browser.getVersion leaves a${kind === 'array' ? 'n' : ''} ${kind} result untouched`, async (t) => {
    const wire = versionWire(t, { kind: 'extension', version: '7.12.0' });
    const answer = await getVersion(wire, { result });
    assert.equal(answer.error, undefined);
    assert.deepEqual(answer.result, result);
  });
}

test('an internal Browser.getVersion answer is unmodified', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sliccExtension');
  const bridgeResults = [];
  const listeners = new Set();
  Object.defineProperty(globalThis, 'sliccExtension', {
    configurable: true,
    value: Object.freeze({
      version: '7.12.0',
      cdp: Object.freeze({
        on(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async send(method) {
          const result =
            method === 'Target.getTargets'
              ? { targetInfos: [] }
              : method === 'Browser.getVersion'
                ? { product: 'Chrome/synthetic' }
                : {};
          if (method === 'Browser.getVersion') bridgeResults.push(result);
          return result;
        },
      }),
    }),
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'sliccExtension', previous);
    else delete globalThis.sliccExtension;
  });
  const connection = await browserHook(
    undefined,
    undefined,
    'https://protected.invalid'
  )({ runtime: 'extension' });
  t.after(() => connection.close());
  const answer = new Promise((resolve) => {
    connection.onmessage = (text) => {
      const reply = JSON.parse(text);
      if (reply.id === 1) resolve(reply);
    };
  });
  connection.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  assert.deepEqual((await answer).result, {
    product: 'Chrome/synthetic',
    slicc: { route: 'extension' },
  });
  assert.deepEqual(bridgeResults, [{ product: 'Chrome/synthetic' }]);
});
