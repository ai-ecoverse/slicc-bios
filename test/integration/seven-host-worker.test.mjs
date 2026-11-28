import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { AGENT, AGENT_REFUSED, MCP_CALLBACK } from '../../src/sw/agent.js';
import { openIntegrity } from '../../src/sw/integrity.js';
import { BROWSERS, LOCK_CACHE, lockKey, lockPin, releaseLock } from '../../src/sw/lock.js';
import { intercept } from '../../src/sw/register.js';
import { scanImports } from '../../src/sw/scan.js';
import { errorsOf, observeNetwork, workerPath } from './seven-host-observation.mjs';

const LOCK = JSON.parse(
  readFileSync(new URL('../../src/packages/package-lock.json', import.meta.url))
);
const CATALOG = `/${BROWSERS}/catalog.json`;
const PATH = `${AGENT}node_modules/@ai-ecoverse/slicc-agent/dist/oauth/mcp-callback.html`;
const ASSET = `${AGENT}asset.html`;
const ROUTES = [MCP_CALLBACK, PATH, ASSET];
const UNAVAILABLE = 'sw: seven’s policy is unavailable. Reload through the BIOS.\n';
const SCRIPT = 'https://seven.sliccy.ai/sw.js';
const OTHER_PIN = `sha512-${Buffer.alloc(64, 123).toString('base64')}`;
const OTHER_LOCK = { packages: { [BROWSERS]: { integrity: OTHER_PIN } } };
const good = JSON.stringify(catalog);
const stale = JSON.stringify({
  ...catalog,
  seven: {
    ...catalog.seven,
    excludedLabels: catalog.seven.excludedLabels.filter((label) => label !== 'lease-pilot'),
  },
});
const hash = (text) => createHash('sha256').update(text).digest('hex');

const files = new Map();
const entries = new Map();
const cache = {
  match: async (url) => entries.get(url)?.clone(),
  put: async (url, response) => entries.set(url, response.clone()),
  delete: async (url) => entries.delete(url),
};
globalThis.caches = {
  open: async (name) => {
    assert.equal(name, LOCK_CACHE);
    return cache;
  },
};
const directory = (path = '') => ({
  getDirectoryHandle: async (name) => directory(`${path}/${name}`),
  getFileHandle: async (name) => ({
    getFile: async () => {
      const text = files.get(`${path}/${name}`);
      if (text === undefined) throw new DOMException(name, 'NotFoundError');
      return new File([text], name, { lastModified: 1 });
    },
  }),
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { storage: { getDirectory: async () => directory() }, locks: { query: async () => ({}) } },
});

let responseLock = LOCK;
let network = [];
globalThis.fetch = async (url, options) => {
  network.push(String(url));
  assert.ok(new URL(url).pathname.endsWith('/packages/package-lock.json'));
  assert.equal(options.cache, 'no-cache');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  if (responseLock instanceof Error) throw responseLock;
  if (responseLock instanceof Response) return responseLock.clone();
  return Response.json(responseLock);
};
const ledger = await openIntegrity();
let instance = 0;

async function installCatalog(
  text = good,
  integrity = LOCK.packages[BROWSERS].integrity,
  source = BROWSERS
) {
  files.set(CATALOG, text);
  await ledger.record(
    source,
    [{ path: CATALOG, size: Buffer.byteLength(text), sha256: hash(text) }],
    integrity
  );
}

async function worker(script = SCRIPT) {
  const listeners = new Map();
  const changes = [];
  const self = {
    location: new URL(script),
    registration: { scope: `${new URL(script).origin}/`, addEventListener() {} },
    addEventListener: (type, listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    skipWaiting: async () => changes.push('skip waiting'),
    clients: { claim: async () => changes.push('claim') },
  };
  globalThis.self = self;
  const url = new URL('../../src/sw.js', import.meta.url);
  url.searchParams.set('worker', String(++instance));
  await import(url.href);
  function event(type, properties = {}) {
    globalThis.self = self;
    const result = [];
    const accept = (promise) => result.push(promise);
    for (const listener of listeners.get(type))
      listener({ ...properties, waitUntil: accept, respondWith: accept });
    return Promise.all(result);
  }
  return {
    changes,
    install: () => event('install'),
    activate: () => event('activate'),
    async request(path) {
      const [response] = await event('fetch', {
        request: new Request(new URL(path, script)),
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

async function start(script) {
  const running = await worker(script);
  await running.install();
  await running.activate();
  return running;
}

const pointer = async (name, script = SCRIPT) => (await cache.match(lockKey(script, name)))?.json();
const savePointer = (name, value, script = SCRIPT) =>
  cache.put(lockKey(script, name), Response.json(value));

async function denied(running) {
  for (const path of ROUTES)
    assert.deepEqual(await running.request(path), { status: 503, body: UNAVAILABLE }, path);
}

async function serves(running) {
  for (const path of ROUTES) {
    assert.deepEqual(
      await running.request(path),
      { status: 200, body: path === ASSET ? 'agent asset' : 'agent callback' },
      path
    );
  }
}

function reset() {
  entries.clear();
  responseLock = LOCK;
  network = [];
  files.set(PATH, 'agent callback');
  files.set(ASSET, 'agent asset');
  return installCatalog();
}

test('the installed worker derives the pin from the release lock at its own URL', async () => {
  await reset();
  assert.equal(lockPin(LOCK), LOCK.packages[BROWSERS].integrity);
  const running = await start('https://seven.sliccy.ai/7/sw.js?afresh');
  assert.deepEqual(network, ['https://seven.sliccy.ai/7/packages/package-lock.json']);
  assert.equal(
    await releaseLock('https://seven.sliccy.ai/7/sw.js?afresh').pin(),
    LOCK.packages[BROWSERS].integrity
  );
  await serves(running);
  responseLock = OTHER_LOCK;
  await installCatalog(good, OTHER_PIN);
  const next = await start(SCRIPT);
  assert.equal(await releaseLock(SCRIPT).pin(), OTHER_PIN);
  await serves(next);
});

test('the worker refuses a stale package with an internally valid catalog and ledger', async () => {
  await reset();
  const running = await start('https://lease-pilot.sliccy.ai/sw.js');
  await installCatalog(stale, OTHER_PIN);
  await denied(running);
  await installCatalog(good);
  for (const path of ROUTES) {
    assert.deepEqual(await running.request(path), { status: 403, body: `${AGENT_REFUSED}\n` });
  }
});

test('the worker refuses warm catalog read, digest and parse failures and serves again after repair', async () => {
  await reset();
  const running = await start();
  await serves(running);
  files.delete(CATALOG);
  await denied(running);
  files.set(CATALOG, good.replace('lease-pilot', 'lease-pilox'));
  await denied(running);
  await installCatalog('{invalid');
  await denied(running);
  await installCatalog(good, LOCK.packages[BROWSERS].integrity, 'unexpected source');
  await denied(running);
  await installCatalog();
  await serves(running);
});

test('an offline worker restart uses its verified active pin without a lock fetch', async () => {
  await reset();
  await start();
  responseLock = new TypeError('offline');
  await serves(await worker());
  assert.deepEqual(network, [new URL('packages/package-lock.json', SCRIPT).href]);
});

test('a waiting worker stages its own copy and only the active pointer serves requests', async () => {
  await reset();
  const first = await start();
  const previous = await pointer('active');
  responseLock = OTHER_LOCK;
  await (await worker()).install();
  const next = await pointer('staged');
  assert.notEqual(next.id, previous.id);
  assert.deepEqual(await pointer('active'), previous);
  await serves(first);
  await serves(await worker());
});

test('a failed worker install stores no unvalidated pin and keeps the active copy and pointer', async () => {
  await reset();
  await start();
  const previous = await pointer('active');
  const keys = [...entries.keys()];
  for (const broken of [
    new TypeError('offline'),
    new Response('', { status: 404 }),
    new Response('{invalid'),
    {},
    { packages: { [BROWSERS]: { integrity: 'wrong' } } },
  ]) {
    responseLock = broken;
    const next = await worker();
    await assert.rejects(next.install());
    assert.deepEqual(next.changes, []);
    assert.deepEqual([...entries.keys()], keys);
    assert.deepEqual(await pointer('active'), previous);
    await serves(await worker());
  }
});

test('after a waiting worker restarts it activates only its freshly staged copy', async () => {
  await reset();
  await start();
  const previous = await pointer('active');
  responseLock = OTHER_LOCK;
  await (await worker()).install();
  const staged = await pointer('staged');
  const next = await worker();
  responseLock = new TypeError('offline');
  await next.activate();
  assert.deepEqual(next.changes, ['claim']);
  assert.deepEqual(await pointer('active'), staged);
  assert.equal(await cache.match(lockKey(SCRIPT, previous.id)), undefined);
  await installCatalog(good, OTHER_PIN);
  await serves(next);
  await serves(await worker());
});

test('activation revalidates the staged copy and preserves the old active pointer on failure', async () => {
  await reset();
  await start();
  const previous = await pointer('active');
  await (await worker()).install();
  const staged = await pointer('staged');
  await cache.put(lockKey(SCRIPT, staged.id), Response.json({ invalid: true }));
  const next = await worker();
  await assert.rejects(next.activate());
  assert.deepEqual(next.changes, []);
  assert.deepEqual(await pointer('active'), previous);
  assert.ok(await cache.match(lockKey(SCRIPT, previous.id)));
  await denied(await worker());
});

test('activation rejects both an abandoned staged ID and a previously activated ID', async () => {
  await reset();
  await start();
  const previous = await pointer('active');
  await (await worker()).install();
  const abandoned = await pointer('staged');
  const next = await worker();
  await next.install();
  assert.notEqual((await pointer('staged')).id, abandoned.id);
  await savePointer('staged', abandoned);
  await assert.rejects(next.activate());
  assert.deepEqual(await pointer('active'), previous);
  await savePointer('staged', previous);
  await assert.rejects((await worker()).activate());
  assert.deepEqual(await pointer('active'), previous);
});

test('a new release cannot use an old release’s lock after a failed install', async () => {
  await reset();
  await start();
  const previous = await pointer('active');
  const script = `${SCRIPT}?afresh`;
  const next = await worker(script);
  responseLock = new TypeError('offline');
  await assert.rejects(next.install());
  await savePointer('active', previous, script);
  await cache.put(lockKey(script, previous.id), await cache.match(lockKey(SCRIPT, previous.id)));
  await denied(await worker(script));
  await serves(await worker());
});

test('tampered, malformed, missing and foreign lock copies return a fixed 503 without hashes', async () => {
  await reset();
  await start();
  const running = await worker();
  await serves(running);
  const previous = await pointer('active');
  await cache.delete(lockKey(SCRIPT, 'active'));
  await denied(running);
  await savePointer('active', previous);
  await serves(running);
  const key = lockKey(SCRIPT, previous.id);
  const original = await cache.match(key);
  await cache.delete(key);
  await denied(running);
  await cache.put(key, original);
  await savePointer('active', { ...previous, id: crypto.randomUUID() });
  await denied(running);
  await savePointer('active', previous);
  for (const malformed of [
    JSON.stringify({ id: previous.id, script: SCRIPT, pin: OTHER_PIN }),
    JSON.stringify({ id: previous.id, script: SCRIPT }),
    JSON.stringify({ id: previous.id, script: SCRIPT, pin: ['invalid'] }),
    '{invalid',
  ]) {
    await cache.put(key, new Response(malformed));
    await denied(running);
  }
  for (const malformed of [
    JSON.stringify({ id: previous.id, script: SCRIPT }),
    JSON.stringify({ id: previous.id, script: SCRIPT, pin: ['invalid'] }),
    '{invalid',
  ]) {
    await cache.put(key, new Response(malformed));
    await savePointer('active', { ...previous, digest: hash(malformed) });
    await denied(running);
  }
  await savePointer('active', { ...previous, digest: 'unknown' });
  await denied(running);
  await cache.put(key, original);
  await savePointer('active', { ...previous, digest: '0'.repeat(64) });
  await denied(running);
  const invalidId = 'not-a-uuid';
  const invalidCopy = JSON.stringify({ id: invalidId, script: SCRIPT, pin: lockPin(LOCK) });
  await cache.put(lockKey(SCRIPT, invalidId), new Response(invalidCopy));
  await savePointer('active', { id: invalidId, digest: hash(invalidCopy) });
  await denied(running);
  await savePointer('active', previous);
  const adopted = await start();
  const active = await pointer('active');
  await savePointer('active', previous);
  await denied(adopted);
  await savePointer('active', active);
  await serves(adopted);
});

test('the #1022 module-only update path depends on the order starting with the first sw.js import', () => {
  const source = readFileSync(new URL('../../src/sw.js', import.meta.url), 'utf8');
  const imports = [
    './sw/integrity.js',
    './sw/loopback.js',
    './sw/opfs.js',
    './sw/resolve.js',
    './sw/routes.js',
    './sw/six.js',
    './sw/stubs.js',
    './sw/transform.js',
  ];
  assert.deepEqual(
    scanImports(source)
      .slice(0, imports.length)
      .map(({ value }) => value),
    imports,
    'The #1022 module-only update path depends on the first import and its following module order.'
  );
});

test('a module-only update on an allowed host stays at /sw.js while it activates', async () => {
  await reset();
  await start();
  const replacement = await worker();
  await replacement.install();
  const previous = { scriptURL: SCRIPT, state: 'activated' };
  const next = { scriptURL: SCRIPT, state: 'activating' };
  const registration = {
    active: previous,
    async update() {
      registration.active = next;
    },
  };
  const attempted = [];
  const container = {
    getRegistration: async () => registration,
    register: async (url) => {
      attempted.push(url.href);
      return registration;
    },
  };

  await cache.put(lockKey(SCRIPT, 'activating'), new Response());
  await intercept(container, new URL(SCRIPT), '/');
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted.splice(0), [SCRIPT, SCRIPT]);

  await replacement.activate();
  next.state = 'activated';
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted.splice(0), [SCRIPT]);
  await serves(replacement);

  await installCatalog(good, OTHER_PIN);
  registration.update = async () => {
    registration.active = { ...next };
  };
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted.splice(0), [SCRIPT]);

  const match = cache.match;
  cache.match = async (key) => {
    registration.active = { ...next, state: 'activating' };
    return match(key);
  };
  try {
    registration.update = async () => {};
    await intercept(container, new URL(SCRIPT), '/');
    assert.deepEqual(attempted, [SCRIPT]);
  } finally {
    cache.match = match;
  }
});

test('an activating worker with no record yet stays at /sw.js and an absent record never forces a fresh install', async () => {
  await reset();
  const activation = { scriptURL: SCRIPT, state: 'activating' };
  const registration = { active: activation, update: async () => {} };
  const attempted = [];
  const container = {
    getRegistration: async () => registration,
    register: async (url) => {
      attempted.push(url.href);
      return registration;
    },
  };
  await intercept(container, new URL(SCRIPT), '/');
  activation.state = 'activated';
  await intercept(container, new URL(SCRIPT), '/');
  await start();
  await ledger.forget(BROWSERS);
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted, [SCRIPT, SCRIPT, SCRIPT]);
});

test('BIOS refresh selects a fresh worker only for a definitively unusable active pin', async (t) => {
  await reset();
  await start();
  const attempted = [];
  const registration = {
    active: { scriptURL: SCRIPT, state: 'activated' },
    update: async () => {},
  };
  const container = {
    getRegistration: async () => registration,
    register: async (url) => {
      attempted.push(url.href);
      return registration;
    },
  };
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted.splice(0), [SCRIPT]);
  await installCatalog(good, OTHER_PIN);
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted.splice(0), [SCRIPT, `${SCRIPT}?afresh`]);
  await installCatalog();
  const active = await pointer('active');
  await cache.delete(lockKey(SCRIPT, active.id));
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted.splice(0), [SCRIPT, `${SCRIPT}?afresh`]);
  await cache.put(lockKey(SCRIPT, 'active'), new Response('{malformed'));
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted.splice(0), [SCRIPT, `${SCRIPT}?afresh`]);
  t.mock.method(cache, 'match', async () => {
    throw new DOMException('storage interrupted', 'AbortError');
  });
  await intercept(container, new URL(SCRIPT), '/');
  assert.deepEqual(attempted, [SCRIPT]);
});

test('the ViewTransition filter retains a different message with the same prefix', () => {
  const prefix = 'InvalidStateError: Transition was aborted because of invalid state.';
  const different = `${prefix} Another transition failed`;
  assert.deepEqual(errorsOf({ errors: [`${prefix} ViewTransition opt-in disabled`, different] }), [
    different,
  ]);
});

test('boot traffic reports Network.enable rejection and a detach before enabling', async () => {
  let emit;
  const observation = observeNetwork({
    on: (listener) => {
      emit = listener;
    },
    send: async (method) => {
      assert.equal(method, 'Network.enable');
      throw new Error('enable failed');
    },
  });
  for (const sessionId of ['one', 'two']) {
    emit({
      method: 'Target.attachedToTarget',
      params: { sessionId, targetInfo: { type: 'service_worker', url: SCRIPT } },
    });
  }
  emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'two' } });
  assert.deepEqual(await observation.failures(), [
    'service_worker one: enable failed',
    'service_worker two detached before enabling: enable failed',
  ]);
});

test('boot traffic refuses installer paths from the service worker with bios false', () => {
  const path = '/installer.js';
  const network = new Set(['/sw.js']);
  const installer = new Set([path]);
  assert.equal(workerPath(path, { network, installer, bios: false }), false);
  assert.equal(workerPath(path, { network, installer, bios: true }), true);
});
