import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { credential, oauthVault, placeholder } from './kernel-oauth-fixture.mjs';

const receiver = await readFile(new URL('./scrub-receipt-worker.mjs', import.meta.url), 'utf8');
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

async function setup(t, { workers = 1 } = {}) {
  const fake = await oauthVault();
  t.after(() => fake.close());
  const page = await chrome.page(t);
  chrome.overrides.set('/oauth-fixture.html', '<!doctype html><title>OAuth relay fixture</title>');
  chrome.overrides.set('/receipt-worker.js', receiver);
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
  await page.evaluate(async (count) => {
    globalThis.receiptWorkers = [];
    globalThis.receiptMessages = [];
    globalThis.workerRpc = (data, worker = globalThis.receiptWorker) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          channel.port1.close();
          resolve(data);
        };
        worker.postMessage(data, [channel.port2]);
      });
    globalThis.addReceiptWorker = async () => {
      const worker = new Worker('/receipt-worker.js', { type: 'module' });
      const id = globalThis.receiptWorkers.length;
      globalThis.receiptWorkers.push(worker);
      await new Promise((resolve) => {
        worker.onmessage = ({ data }) => {
          if (data.ready) resolve();
          if (data.applied) globalThis.seenScrubs.push(data.applied.version);
          if (data.receipt) globalThis.receiptMessages.push({ worker: id, ...data.receipt });
        };
      });
      worker.detach = globalThis.oauthVault.attach(worker);
      return worker;
    };
    for (let i = 0; i < count; i += 1) await globalThis.addReceiptWorker();
    globalThis.receiptWorker = globalThis.receiptWorkers[0];
  }, workers);
  t.after(() =>
    page
      .evaluate(() => {
        globalThis.oauthVault.close();
        for (const worker of globalThis.receiptWorkers) worker.terminate();
      })
      .catch(() => {})
  );
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
    assert.equal(
      (await page.evaluate(() => globalThis.workerRpc({ inspect: true }))).applied.version,
      8
    );
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
  assert.equal(fake.requests.filter((request) => request.sealed === 'oauthGrant').length, 1);
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
  assert.equal(
    (await page.evaluate(() => globalThis.workerRpc({ inspect: true }))).applied.version,
    9
  );
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

const mode = (page, value) => page.evaluate((mode) => globalThis.workerRpc({ mode }), value);
const begin = (page, request = grant) =>
  page.evaluate(
    (request) => {
      globalThis.receiptMessages = [];
      globalThis.oauthFinished = false;
      globalThis.oauthAbort = new AbortController();
      globalThis.pendingOAuth = globalThis.oauthVault
        .sealed(request, { signal: globalThis.oauthAbort.signal })
        .then((reply) => {
          globalThis.oauthFinished = true;
          return reply;
        });
    },
    { ...request, caller }
  );

const received = (page, count = 1) =>
  page.within(7000, (count) => globalThis.receiptMessages.length >= count, count);

test('a real worker must apply and privately acknowledge the current pair before initial credentials leave bios', async (t) => {
  const { fake, page } = await setup(t);
  await mode(page, 'hold');
  await begin(page);
  await received(page);
  assert.equal(await page.evaluate(() => globalThis.oauthFinished), false);
  assert.equal(
    fake.requests.some((request) => request.sealed === 'oauthGrant'),
    false
  );
  assert.equal(
    (await page.evaluate(() => globalThis.workerRpc({ inspect: true }))).applied.needed,
    false
  );
  await mode(page, 'ack');
  await page.evaluate(() => globalThis.receiptWorker.postMessage({ release: true }));
  assert.deepEqual(await page.evaluate(() => globalThis.pendingOAuth), credential);
  const receipts = await page.evaluate(() => globalThis.receiptMessages);
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].nonce, receipts[1].nonce);
  assert.ok(receipts.every((receipt) => /^[0-9a-f]{32}$/.test(receipt.nonce)));
});

test('mutation completion waits for a real worker to apply its new pair, independently of the pre-adoption receipt', async (t) => {
  const { fake, page } = await setup(t);
  fake.set({
    placeholders: { scrub: { needed: false, version: 1, ready: true } },
    afterMutation: { placeholders: { scrub: { needed: true, version: 8, ready: true } } },
  });
  await mode(page, 'hold-second');
  await begin(page);
  await received(page, 2);
  assert.equal(await page.evaluate(() => globalThis.oauthFinished), false);
  assert.equal(fake.requests.filter((request) => request.sealed === 'oauthGrant').length, 1);
  assert.deepEqual((await page.evaluate(() => globalThis.workerRpc({ inspect: true }))).applied, {
    needed: false,
    version: 1,
    ready: true,
  });
  await page.evaluate(() => globalThis.receiptWorker.postMessage({ release: true }));
  assert.deepEqual(await page.evaluate(() => globalThis.pendingOAuth), credential);
  assert.equal(
    (await page.evaluate(() => globalThis.workerRpc({ inspect: true }))).applied.version,
    8
  );
});

test('malformed, stale and wrong-worker private receipts cannot make the capability usable', async (t) => {
  const { fake, page } = await setup(t, { workers: 2 });
  for (const value of ['nonce', 'version', 'protocol', 'extra', 'extra-port']) {
    await mode(page, value);
    const reply = await ask(page, { v: 1, op: 'capabilities' });
    assert.equal(reply.error.code, 'ENOTCONN', value);
  }
  await page.evaluate(async () => {
    for (const worker of globalThis.receiptWorkers)
      await globalThis.workerRpc({ mode: 'hold' }, worker);
  });
  await begin(page, { v: 1, op: 'capabilities' });
  await received(page, 2);
  await page.evaluate(() => {
    const other = globalThis.receiptMessages.find((receipt) => receipt.worker === 1);
    globalThis.receiptWorkers[0].postMessage({
      release: true,
      reply: { v: 1, nonce: other.nonce, version: other.version },
    });
    globalThis.receiptWorkers[1].postMessage({ release: true });
  });
  assert.equal((await page.evaluate(() => globalThis.pendingOAuth)).error.code, 'ENOTCONN');
  assert.equal(
    fake.requests.some((request) => request.sealed === 'capabilities'),
    false
  );
});

test('old receivers, lost receipts and global Worker messages time out without sending initial tokens', {
  timeout: 30000,
}, async (t) => {
  const { fake, page } = await setup(t);
  for (const value of ['old', 'closed', 'global']) {
    await mode(page, value);
    const reply = await ask(page, grant);
    assert.equal(reply.error.code, 'ETIMEDOUT', value);
  }
  assert.equal(
    fake.requests.some((request) => request.sealed === 'oauthGrant'),
    false
  );
});

test('attachment, owned termination and reconnect invalidate pending receipts; missing receipts never prove worker death', {
  timeout: 30000,
}, async (t) => {
  for (const action of ['attach', 'detach', 'reconnect', 'unowned-termination']) {
    await t.test(action, async (t) => {
      const { fake, page } = await setup(t);
      await mode(page, 'hold');
      await begin(page);
      await received(page);
      await page.evaluate(async (action) => {
        if (action === 'attach') await globalThis.addReceiptWorker();
        if (action === 'reconnect') await globalThis.oauthVault.reconnect();
        if (action === 'detach') globalThis.receiptWorker.detach();
        if (action.endsWith('termination') || action === 'detach')
          globalThis.receiptWorker.terminate();
      }, action);
      assert.equal(
        (await page.evaluate(() => globalThis.pendingOAuth)).error.code,
        action === 'unowned-termination' ? 'ETIMEDOUT' : 'ENOTCONN'
      );
      assert.equal(
        fake.requests.some((request) => request.sealed === 'oauthGrant'),
        false
      );
      if (action === 'detach')
        assert.deepEqual(await ask(page, { v: 1, op: 'capabilities' }), {
          v: 1,
          capabilities: { kernelOAuth: 1 },
        });
    });
  }
});

test('a worker attached after initial credentials were sent prevents completion without replaying the grant', async (t) => {
  const { fake, page } = await setup(t);
  fake.set({ hold: 'oauthGrant' });
  const sent = fake.waitFor('oauthGrant');
  await begin(page);
  await sent;
  await page.evaluate(() => globalThis.addReceiptWorker().then(() => undefined));
  fake.set({});
  fake.release();
  assert.equal((await page.evaluate(() => globalThis.pendingOAuth)).error.code, 'ENOTCONN');
  assert.equal(fake.requests.filter((request) => request.sealed === 'oauthGrant').length, 1);
  assert.deepEqual(await ask(page, { v: 1, op: 'capabilities' }), {
    v: 1,
    capabilities: { kernelOAuth: 1 },
  });
});

test('cancellation closes the old private receipt path and a late receipt cannot complete the next operation', async (t) => {
  const { fake, page } = await setup(t);
  await mode(page, 'hold');
  await begin(page);
  await received(page);
  const old = await page.evaluate(() => globalThis.receiptMessages[0]);
  await page.evaluate(() => globalThis.oauthAbort.abort());
  assert.equal((await page.evaluate(() => globalThis.pendingOAuth)).error.code, 'ENOTCONN');
  await page.evaluate(() => globalThis.receiptWorker.postMessage({ release: true }));
  await begin(page, { v: 1, op: 'capabilities' });
  await received(page);
  assert.equal(await page.evaluate(() => globalThis.oauthFinished), false);
  await page.evaluate((reply) => globalThis.receiptWorker.postMessage({ release: true, reply }), {
    v: 1,
    nonce: old.nonce,
    version: old.version,
  });
  assert.equal((await page.evaluate(() => globalThis.pendingOAuth)).error.code, 'ENOTCONN');
  assert.equal(
    fake.requests.some((request) => request.sealed === 'oauthGrant'),
    false
  );
});
