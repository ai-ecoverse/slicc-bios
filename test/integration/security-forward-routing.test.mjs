import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { createExitRouter } from '../../src/seed/exits.js';
import { createForwarder } from '../../src/seed/forward.js';
import { linkExit } from '../../src/seed/link.js';
import { createNetwork } from '../../src/seed/network.js';
import { EXTENSION_UPDATE_HINT, pickTransport } from '../../src/seed/transport.js';
import { unfollowed } from '../../src/seed/vault.js';

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

test('a request during policy seeding refuses cleanly before the vault or carrier, then works after readiness', {
  timeout: 10000,
}, async (t) => {
  let ready = false;
  const f = fixture(t);
  const forward = createForwarder({ vault: f.vault, select: () => f.selected, ready: () => ready });
  await assert.rejects(forward(request, { signal: new AbortController().signal }), {
    status: 403,
    code: 'EACCES',
    message: 'the credentialed request was refused',
  });
  assert.equal(f.ports.length, 0);
  assert.equal(f.sends.length, 0);
  ready = true;
  const response = await forward(request, { signal: new AbortController().signal });
  assert.equal(response.status, 200);
  assert.equal(await consume(response), 'response');
  assert.equal(f.sends.length, 1);
});

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
  let timer;
  try {
    await Promise.race([
      f.cancellation.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('fatal S1 did not cancel the raw carrier')),
          1000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    const network = createNetwork(choice);
    for (const redirect of ['manual', 'error']) {
      await assert.rejects(network.transport.fetch({ ...request, redirect }), {
        name: 'TypeError',
        code: 'EACCES',
        status: 502,
        message: EXTENSION_UPDATE_HINT,
      });
      assert.equal(network.port.status().health, 'limited');
      assert.equal(network.port.status().detail, EXTENSION_UPDATE_HINT);
    }
    assert.equal(network.port.status().failures.length, 2);
  }
  assert.equal(extensionCalls, 0);
  assert.equal(nativeCalls, 0);
});

test('a capability-advertising link remains refused for credentialed and explicit manual requests', {
  timeout: 10000,
}, async (t) => {
  let opened = 0;
  let baseCalls = 0;
  const peer = { routes: { exit: true } };
  const exit = linkExit(
    {
      peer: () => peer,
      closed: () => false,
      caps: () => ['http', 'net', 'credentialed'],
      open: async () => {
        opened += 1;
        throw new Error('unproven link opened');
      },
    },
    {
      id: 'link:unproven',
      device: () => 'unproven',
      address: () => '100.64.0.1',
      label: () => 'unproven',
    }
  );
  const router = createExitRouter();
  router.add(exit);
  router.choose(exit.id);
  assert.equal(exit.credentialed, null);
  assert.equal(router.selectCredentialed(request.url), null);
  const f = fixture(t);
  const forward = createForwarder({
    vault: f.vault,
    select: (url) => router.selectCredentialed(url),
    ready: () => true,
  });
  await assert.rejects(forward(request, { signal: new AbortController().signal }));
  const transport = router.transport({
    traits: { redirectPolicy: true },
    fetch: async () => {
      baseCalls += 1;
      throw new Error('native fallback');
    },
  });
  for (const redirect of ['manual', 'error'])
    await assert.rejects(transport.fetch({ ...request, headers: head.headers, redirect }));
  assert.equal(f.ports.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(opened, 0);
  assert.equal(baseCalls, 0);
});

test('a routed page token refresh reaches its selected endpoint with manual redirects', {
  timeout: 10000,
}, async (t) => {
  const prior = { indexedDB: globalThis.indexedDB, extension: globalThis.sliccExtension };
  globalThis.indexedDB = indexedDB;
  delete globalThis.sliccExtension;
  t.after(() => {
    globalThis.indexedDB = prior.indexedDB;
    globalThis.sliccExtension = prior.extension;
  });
  const received = [];
  const endpoint = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ method: req.method, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"synthetic-result"}');
    });
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => endpoint.close(resolve)));
  const choice = await pickTransport();
  const transport = createExitRouter().transport(choice.transport);
  assert.equal(transport.traits.redirectPolicy, true);
  const response = await unfollowed(transport, {
    method: 'POST',
    url: `http://127.0.0.1:${endpoint.address().port}/token`,
    headers: [['content-type', 'application/x-www-form-urlencoded']],
    body: bytes('grant_type=refresh_token&refresh_token=synthetic-refresh'),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await consume(response)), { access_token: 'synthetic-result' });
  assert.deepEqual(received, [
    { method: 'POST', body: 'grant_type=refresh_token&refresh_token=synthetic-refresh' },
  ]);
});
