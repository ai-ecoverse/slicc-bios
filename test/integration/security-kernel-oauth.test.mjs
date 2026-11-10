import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { credential, oauthVault, placeholder } from './kernel-oauth-fixture.mjs';

const chrome = await launch({ vault: false });
after(() => chrome.close());
const caller = {
  pid: 7,
  ppid: 1,
  uid: 1001,
  gid: 1001,
  tag: 'test',
  groups: [27],
  users: 'enforce',
};
const identity = { name: 'EXAMPLE_TOKEN', provider: 'example', account: 'default' };
const grant = {
  v: 1,
  op: 'oauthGrant',
  ...identity,
  accessToken: 'fake-initial-access',
  refreshToken: 'fake-initial-refresh',
  oauth: {
    tokenUrl: 'https://auth.example.invalid/token',
    clientId: 'example',
    authMethod: 'none',
  },
};

async function setup(t) {
  const fake = await oauthVault();
  t.after(() => fake.close());
  const page = await chrome.page(t);
  chrome.overrides.set('/oauth-fixture.html', '<!doctype html><title>OAuth relay fixture</title>');
  await page.goto('/oauth-fixture.html');
  await page.evaluate(async (origin) => {
    const { createVault } = await import('/seed/vault.js');
    globalThis.seenScrubs = [];
    globalThis.oauthVault = createVault({
      origin,
      users: () => 'enforce',
      sudoGid: async () => 27,
      transport: {
        traits: { redirectPolicy: true },
        fetch: async () => {
          throw Object.assign(new Error('fake-egress-value'), { code: 'fake-egress-value' });
        },
      },
    });
  }, fake.origin);
  await page.until(() => globalThis.oauthVault.port.availability() === 'ready');
  await page.evaluate(() => {
    globalThis.oauthVault.attach({
      postMessage(message) {
        message.vault?.close();
        if (message.scrub) globalThis.seenScrubs.push(message.scrub.version);
      },
    });
  });
  t.after(() => page.evaluate(() => globalThis.oauthVault.close()).catch(() => {}));
  return { fake, page };
}

const ask = (page, req) =>
  page.evaluate((req) => globalThis.oauthVault.sealed(req), { ...req, caller });

test('the page relay asserts kernel OAuth only outside the request, keeps the kernel stamp and completes mutations after publishing current scrub state', async (t) => {
  const { fake, page } = await setup(t);
  assert.deepEqual(await ask(page, { v: 1, op: 'capabilities' }), {
    v: 1,
    capabilities: { kernelOAuth: 1 },
  });
  for (const op of ['oauthGrant', 'oauthRefresh', 'oauthRemove']) {
    fake.set({ placeholders: { scrub: { needed: true, version: 8, ready: true } } });
    const reply = await ask(page, op === 'oauthGrant' ? grant : { v: 1, op, ...identity });
    assert.deepEqual(reply, op === 'oauthRemove' ? { v: 1, removed: true } : credential);
    assert.equal(await page.evaluate(() => globalThis.seenScrubs.at(-1)), 8);
  }
  assert.deepEqual(await ask(page, { v: 1, op: 'oauthStatus', ...identity }), credential);
  const calls = fake.requests.filter((request) => request.op === 'sealed');
  assert.equal(calls.length, 5);
  for (const request of calls) {
    assert.equal(request.marker, 1);
    assert.deepEqual(request.stamp, caller);
    assert.equal(request.fields.includes('caller'), false);
    assert.equal(request.fields.includes('kernelOAuth'), false);
  }
  const sent = calls.find((request) => request.sealed === 'oauthGrant');
  assert.equal(sent.access, true);
  assert.equal(sent.refresh, true);
  assert.deepEqual(sent.oauthFields, ['tokenUrl', 'clientId', 'authMethod']);
  assert.equal(JSON.stringify(fake.requests).includes('fake-initial'), false);
  assert.deepEqual(page.errors, []);
});

test('old or incompatible vault capabilities fail closed before initial tokens are sent and legacy requests get no assertion', async (t) => {
  const { fake, page } = await setup(t);
  for (const capabilities of [{}, { kernelOAuth: 2 }]) {
    fake.set({ status: { capabilities } });
    assert.deepEqual(await ask(page, { v: 1, op: 'capabilities' }), { v: 1, capabilities: {} });
    assert.equal((await ask(page, grant)).error.code, 'ENOTSUP');
  }
  assert.equal(
    fake.requests.some((request) => request.sealed === 'oauthGrant'),
    false
  );
  fake.set({ reply: { v: 1, secrets: [] } });
  assert.deepEqual(await ask(page, { v: 1, op: 'list', kernelOAuth: 1 }), { v: 1, secrets: [] });
  assert.equal(fake.requests.findLast((request) => request.op === 'sealed').marker, undefined);
  fake.set({ status: { protocol: 2 } });
  assert.equal((await ask(page, { v: 1, op: 'capabilities' })).error.code, 'EIO');
});

test('malformed OAuth results, nested and outer error payloads and incompatible envelope versions never escape the page relay', async (t) => {
  const { fake, page } = await setup(t);
  const malformed = [
    null,
    { ...credential, v: 2 },
    { ...credential, value: 'fake-initial-refresh' },
    { ...credential, placeholder: 'fake-initial-access' },
    { ...credential, state: 'inert' },
    { ...credential, expiresAt: -1 },
    { ...credential, expiresAt: 1.5 },
    { ...credential, refreshable: 'true' },
    { v: 1, error: { code: 'PRIVATE', message: 'fake-initial-refresh' } },
    { v: 1, error: { code: 'EACCES', cause: 'private', message: 'fake-initial-refresh' } },
    {
      v: 1,
      error: { code: 'EACCES', message: 'fake-initial-refresh', token: 'fake-initial-access' },
    },
  ];
  for (const reply of malformed) {
    fake.set({ reply });
    const result = await ask(page, { v: 1, op: 'oauthStatus', ...identity });
    assert.deepEqual(result, {
      v: 1,
      error: { code: 'EIO', message: 'Invalid vault OAuth response' },
    });
  }
  fake.set({
    reply: {
      v: 1,
      error: { code: 'EACCES', cause: 'vault-locked', message: 'fake-initial-refresh' },
    },
  });
  assert.deepEqual(await ask(page, grant), {
    v: 1,
    error: { code: 'EACCES', cause: 'vault-locked', message: 'Vault is locked' },
  });
  for (const envelope of [{ v: 2 }, { op: 'status' }, { token: 'fake-initial-access' }]) {
    fake.set({ envelope });
    assert.equal((await ask(page, grant)).error.code, 'EIO');
  }
  fake.set({
    envelope: {
      op: undefined,
      reply: undefined,
      error: { code: 'EACCES', message: 'fake-initial-refresh' },
    },
  });
  assert.deepEqual(await ask(page, grant), {
    v: 1,
    error: { code: 'EACCES', message: 'OAuth request refused' },
  });
  assert.deepEqual(page.errors, []);
});

test('a scrub barrier failure or stale pair refuses mutation completion without replaying the initial credentials', async (t) => {
  const { fake, page } = await setup(t);
  for (const scrub of [
    { needed: true, version: 0, ready: true },
    { needed: true, version: 9, ready: false },
    { needed: true, version: 9 },
  ]) {
    fake.set({ placeholders: { scrub } });
    assert.equal((await ask(page, grant)).error.code, 'ENOTCONN');
  }
  assert.equal(fake.requests.filter((request) => request.sealed === 'oauthGrant').length, 3);
});

test('a locked removal publishes its current fail-closed scrub pair and still confirms removal', async (t) => {
  const { fake, page } = await setup(t);
  fake.set({
    status: { locked: true },
    placeholders: { scrub: { needed: true, version: 9, ready: false } },
  });
  assert.deepEqual(await ask(page, { v: 1, op: 'oauthRemove', ...identity }), {
    v: 1,
    removed: true,
  });
  assert.deepEqual(await page.evaluate(() => globalThis.oauthVault.scrub()), {
    needed: true,
    version: 9,
    ready: false,
  });
  assert.equal(await page.evaluate(() => globalThis.seenScrubs.at(-1)), 9);
  assert.equal((await ask(page, grant)).error.code, 'ENOTCONN');
});

test('a reconnect or caller cancellation discards late completion and never replays a mutation or its sensitive status probe', async (t) => {
  const { fake, page } = await setup(t);
  for (const op of ['status', 'oauthGrant']) {
    fake.set({ hold: op });
    const sent = fake.waitFor(op);
    await page.evaluate(
      (req) => {
        globalThis.pendingOAuth = globalThis.oauthVault.sealed(req);
      },
      { ...grant, caller }
    );
    await sent;
    await page.evaluate(() => globalThis.oauthVault.reconnect());
    assert.equal((await page.evaluate(() => globalThis.pendingOAuth)).error.code, 'ENOTCONN');
    fake.set({});
    fake.release();
    await page.until(() => globalThis.oauthVault.port.availability() === 'ready');
  }
  const before = fake.requests.filter((request) => request.sealed === 'oauthGrant').length;
  fake.set({ hold: 'oauthGrant' });
  const sent = fake.waitFor('oauthGrant');
  await page.evaluate(
    (req) => {
      globalThis.oauthAbort = new AbortController();
      globalThis.pendingOAuth = globalThis.oauthVault.sealed(req, {
        signal: globalThis.oauthAbort.signal,
      });
    },
    { ...grant, caller }
  );
  await sent;
  await page.evaluate(() => globalThis.oauthAbort.abort());
  assert.equal((await page.evaluate(() => globalThis.pendingOAuth)).error.code, 'ENOTCONN');
  fake.set({});
  fake.release();
  assert.deepEqual(await ask(page, { v: 1, op: 'oauthStatus', ...identity }), credential);
  assert.equal(
    fake.requests.filter((request) => request.sealed === 'oauthGrant').length,
    before + 1
  );
});

test('vault egress keeps its selected manual transport and never reflects a transport error code carrying a value', async (t) => {
  const { fake, page } = await setup(t);
  const result = await page.evaluate(async () => {
    const { answerEgress } = await import('/seed/vault.js');
    let sent;
    let reply;
    await answerEgress(
      {
        traits: { redirectPolicy: true },
        fetch: async (request) => {
          sent = request;
          throw Object.assign(new Error('fake-egress-value'), { code: 'fake-egress-value' });
        },
      },
      { url: 'https://auth.example.invalid/token', method: 'POST', body: 'fake-refresh-body' },
      {
        postMessage: (message) => {
          reply = message;
        },
      }
    );
    return { reply, redirect: sent.redirect, cleared: sent.body.every((byte) => byte === 0) };
  });
  assert.deepEqual(result, {
    reply: { error: 'EIO: the token request failed' },
    redirect: 'manual',
    cleared: true,
  });
  assert.equal(
    fake.requests.some((request) => request.sealed === 'oauthRefresh'),
    false
  );
  assert.deepEqual(page.errors, []);
  assert.equal(placeholder.length, 35);
});
