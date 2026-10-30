import assert from 'node:assert/strict';
import { test } from 'node:test';

const { browserHook, browserHosts } = await import(
  process.env.CDP_SOURCE ?? '../../src/seed/cdp.js'
);
const message =
  'slicc: refused: Update slicc-extension to use browser automation in seven. Reload this tab after updating.';

function extension(t, version) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sliccExtension');
  const calls = [];
  const listeners = new Set();
  const api = Object.freeze({
    ...(version === undefined ? {} : { version }),
    fetch: async () => new Response('ordinary fetch still works'),
    signIn: async () => 'synthetic-sign-in',
    cdp: Object.freeze({
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async send(method, params, sessionId) {
        calls.push({ method, params, sessionId });
        return method === 'Target.getTargets'
          ? { targetInfos: [] }
          : method === 'Browser.getVersion'
            ? { product: 'Chrome/synthetic' }
            : {};
      },
    }),
  });
  Object.defineProperty(globalThis, 'sliccExtension', { configurable: true, value: api });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'sliccExtension', previous);
    else delete globalThis.sliccExtension;
  });
  return { api, calls, listeners };
}

for (const [kind, version] of [
  ['below', '7.9.16'],
  ['missing', undefined],
  ['malformed', '7.10.0-beta'],
  ['four components', '7.10.0.1'],
  ['leading zero', '7.010.0'],
  ['whitespace', ' 7.10.0'],
  ['number', 7100],
  ['null', null],
]) {
  test(`extension automation ${kind} version fails closed before any CDP dispatch`, async (t) => {
    const { api, calls, listeners } = extension(t, version);
    const hook = browserHook(undefined, undefined, 'https://protected.invalid');
    assert.equal(browserHosts().extension, undefined);
    await assert.rejects(hook({ runtime: 'extension' }), { message });
    await assert.rejects(hook(), { message });
    assert.equal(calls.length, 0);
    assert.equal(listeners.size, 0);
    assert.equal(
      await (await api.fetch('https://ordinary.invalid')).text(),
      'ordinary fetch still works'
    );
    assert.equal(await api.signIn(), 'synthetic-sign-in');
  });
}

for (const [kind, version] of [
  ['equal', '7.10.0'],
  ['higher patch', '7.10.1'],
  ['higher minor', '7.11.0'],
  ['higher major', '8.0.0'],
]) {
  test(`extension automation ${kind} version preserves normal public CDP dispatch`, async (t) => {
    const { calls } = extension(t, version);
    assert.equal(typeof browserHosts().extension, 'function');
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
    assert.deepEqual((await answer).result, { product: 'Chrome/synthetic' });
    assert.ok(calls.some((call) => call.method === 'Browser.getVersion'));
  });
}
