import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { createExitRouter } from '../../src/seed/exits.js';
import { createForwarder } from '../../src/seed/forward.js';
import { pickTransport } from '../../src/seed/transport.js';

const bytes = (text) => new TextEncoder().encode(text);
const request = {
  v: 1,
  caller: { pid: 1, uid: 0, gid: 0, users: 'enforce' },
  method: 'POST',
  url: 'https://forward.example.test/path',
  headers: [['Authorization', `Bearer fnox_proxy_${'a'.repeat(24)}`]],
};
const head = { ...request, headers: [['Authorization', 'Bearer synthetic-value']] };
const deferred = () => Promise.withResolvers();

function fixture(t, { prepare, raw } = {}) {
  const ports = [];
  const sends = [];
  const cancellation = deferred();
  const peer = {
    status: 200,
    statusText: 'OK',
    headers: [],
    url: request.url,
    body: (async function* () {
      yield bytes('response');
    })(),
    cancel: async () => cancellation.resolve(),
    ...raw,
  };
  const selected = {
    exit: 'page',
    rawTraits: { manualRedirects: true, encodedBodies: false },
    maxRequestBody: 64 * 1024 * 1024,
    streamingBodies: true,
    active: () => true,
    fetch: async (sent) => {
      sends.push(sent);
      return peer;
    },
  };
  const vault = {
    forwardEpoch: () => 1,
    port: { on: () => () => {} },
    async forward(input, port) {
      ports.push(port);
      port.onmessage = ({ data }) => {
        if (data.op === 'response') port.postMessage(data);
        else if (data.op === 'body') {
          port.postMessage(data);
          port.postMessage({ op: 'credit', bytes: data.chunk.byteLength });
        } else if (data.op === 'end' || data.op === 'error') port.postMessage(data);
      };
      port.start();
      return prepare ? prepare(input, port) : { mode: 'secret', head };
    },
  };
  t.after(() => {
    for (const port of ports) port.close();
  });
  return {
    ports,
    sends,
    cancellation,
    selected,
    vault,
    run: (input = request) =>
      createForwarder({ vault, select: () => selected, ready: () => true })(input, {
        signal: new AbortController().signal,
      }),
  };
}

async function consume(response) {
  let text = '';
  for await (const chunk of response.body) text += new TextDecoder().decode(chunk);
  return text;
}

test('a prepared request cannot cross a selected device identity change', {
  timeout: 10000,
}, async (t) => {
  let identity = 'device:A';
  const entered = deferred();
  const finish = deferred();
  const f = fixture(t, {
    prepare: async () => {
      entered.resolve();
      await finish.promise;
      return { mode: 'secret', head };
    },
  });
  const router = createExitRouter();
  router.add({
    id: 'link:A',
    kind: 'link',
    active: () => true,
    claims: () => true,
    offersDefault: () => true,
    prefixes: () => [],
    exitName: () => identity,
    credentialed: {
      ...f.selected,
      traits: { manualRedirects: true, encodedBodies: false, maxRequestBody: 1024 },
    },
  });
  const forward = createForwarder({
    vault: f.vault,
    select: (url) => router.selectCredentialed(url),
    ready: () => true,
  });
  const result = forward(request, { signal: new AbortController().signal });
  await entered.promise;
  identity = 'device:B';
  router.sync();
  finish.resolve();
  await assert.rejects(result);
  assert.equal(f.sends.length, 0);
});

test('MCP needsBody cannot reclassify an exhausted stream as an ordinary secret', {
  timeout: 10000,
}, async (t) => {
  let attempts = 0;
  const f = fixture(t, {
    prepare: async (input) => {
      attempts += 1;
      if (attempts === 1) return { needsBody: true };
      assert.equal(new TextDecoder().decode(input.body), 'complete original');
      return { mode: 'secret', head };
    },
  });
  await assert.rejects(
    f.run({
      ...request,
      bodyStream: (async function* () {
        yield bytes('complete original');
      })(),
    })
  );
  assert.equal(attempts, 2);
  assert.equal(f.sends.length, 0);
});

test('fatal S1 failure cancels a paused carrier without another consumer pull', {
  timeout: 10000,
}, async (t) => {
  const idle = deferred();
  const f = fixture(t, {
    raw: {
      body: (async function* () {
        yield bytes('first');
        await idle.promise;
      })(),
    },
  });
  const response = await f.run();
  assert.equal(new TextDecoder().decode((await response.body.next()).value), 'first');
  f.ports[0].postMessage({ op: 'error' });
  await f.cancellation.promise;
  assert.equal(f.sends[0].signal.aborted, true);
  await assert.rejects(response.body.next());
  idle.resolve();
});

test('opaque manual responses return a scrubbed 502 rather than a hook refusal', {
  timeout: 10000,
}, async (t) => {
  let scrubbedHeads = 0;
  const f = fixture(t, {
    raw: { status: 0, opaqueRedirect: true, headers: [['x-raw', 'synthetic-value']] },
    prepare: async (input, port) => {
      port.onmessage = ({ data }) => {
        if (data.op === 'response') {
          scrubbedHeads += 1;
          port.postMessage(data);
        } else if (data.op === 'body') {
          port.postMessage(data);
          port.postMessage({ op: 'credit', bytes: data.chunk.byteLength });
        } else if (data.op === 'end') port.postMessage(data);
      };
      return { mode: 'secret', head };
    },
  });
  const response = await f.run();
  assert.equal(response.status, 502);
  assert.equal(scrubbedHeads, 1);
  assert.equal(JSON.stringify(response.headers).includes('synthetic-value'), false);
  assert.match(await consume(response), /redirected; not followed/);
});

test('old extension manual and credentialed sends are refused without native fallback', {
  timeout: 10000,
}, async (t) => {
  const old = {
    indexedDB: globalThis.indexedDB,
    extension: globalThis.sliccExtension,
    fetch: globalThis.fetch,
  };
  let extensionCalls = 0;
  let nativeCalls = 0;
  globalThis.indexedDB = indexedDB;
  globalThis.fetch = async () => {
    nativeCalls += 1;
    throw new Error('native fallback');
  };
  t.after(() => {
    globalThis.indexedDB = old.indexedDB;
    globalThis.sliccExtension = old.extension;
    globalThis.fetch = old.fetch;
  });
  for (const version of [undefined, '7.10.0', '7.11.0-beta']) {
    globalThis.sliccExtension = {
      version,
      fetch: async () => {
        extensionCalls += 1;
        throw new Error('old extension');
      },
    };
    const choice = await pickTransport();
    assert.equal(choice.kind, 'extension');
    assert.equal(choice.credentialed, null);
    for (const redirect of ['manual', 'error'])
      await assert.rejects(choice.transport.fetch({ ...request, redirect }));
  }
  assert.equal(extensionCalls, 0);
  assert.equal(nativeCalls, 0);
});
