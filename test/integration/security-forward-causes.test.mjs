import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORWARD_CAUSES, VAULT_CAUSES } from '../../src/seed/causes.js';
import { createExitRouter } from '../../src/seed/exits.js';
import { createForwarder } from '../../src/seed/forward.js';
import { createPolicySync } from '../../src/seed/policy.js';
import { failure, forwardState } from '../../src/seed/vault.js';

const bytes = (text) => new TextEncoder().encode(text);
const SECRET = 'synthetic-secret-value-0000';
const PLACEHOLDER = `fnox_proxy_${'b'.repeat(24)}`;
const request = {
  v: 1,
  caller: { pid: 7, ppid: 1, uid: 0, gid: 0, users: 'enforce', tag: 'cone' },
  method: 'POST',
  url: 'https://mcp.example.test/mcp',
  headers: [['Authorization', `Bearer ${PLACEHOLDER}`]],
};
const head = { ...request, headers: [['Authorization', `Bearer ${SECRET}`]] };

function forwarder({ answer, vault = {}, selected = {}, select, ready, unready, ...rest } = {}) {
  const route = {
    exit: 'page',
    rawTraits: { manualRedirects: true, encodedBodies: false },
    maxRequestBody: 1024,
    active: () => true,
    fetch: async () => {
      throw new Error('a refused request reached the carrier');
    },
    ...selected,
  };
  const asked = [];
  const ports = [];
  const forward = createForwarder({
    vault: {
      forwardEpoch: () => 1,
      port: { on: () => () => {} },
      async forward(input, port) {
        asked.push(input);
        ports.push(port);
        port.onmessage = ({ data }) => {
          if (data.op === 'body') {
            port.postMessage(data);
            port.postMessage({ op: 'credit', bytes: data.chunk.byteLength });
          } else port.postMessage(data);
        };
        port.start();
        return answer ? answer(input, asked.length) : { mode: 'secret', head };
      },
      ...vault,
    },
    select: select ?? (() => route),
    ready: ready ?? (() => true),
    unready,
    ...rest,
  });
  const run = (input = request) => forward(input, { signal: new AbortController().signal });
  return {
    run,
    asked,
    close: () => {
      for (const port of ports) port.close();
    },
  };
}

async function refusal(t, options, input, status = 403) {
  const f = forwarder(options);
  t.after(f.close);
  const error = await f.run(input).then(
    () => assert.fail('the request was not refused'),
    (e) => e
  );
  assert.equal(error.status, status);
  assert.match(error.message, /^the credentialed request was refused \(([a-z-]+)\): /);
  assert.equal(error.message.includes(SECRET), false);
  assert.equal(error.message.includes(PLACEHOLDER), false);
  const cause = /\(([a-z-]+)\)/.exec(error.message)[1];
  assert.equal(error.cause, cause);
  assert.ok(Object.hasOwn(FORWARD_CAUSES, cause));
  assert.equal(
    error.message,
    `the credentialed request was refused (${cause}): ${FORWARD_CAUSES[cause]}`
  );
  return { cause, asked: f.asked };
}

const stream = (...chunks) =>
  (async function* () {
    for (const chunk of chunks) yield chunk;
  })();

test('protocol refusals name the version, the body framing and a vault reply this seven does not take', async (t) => {
  const cases = [
    [{}, { ...request, v: 2 }, 'protocol-version'],
    [{}, { ...request, body: bytes('a'), bodyStream: stream(bytes('a')) }, 'body-framing'],
    [{}, { ...request, body: 'not bytes' }, 'body-framing'],
    [{}, { ...request, bodyStream: stream('not bytes') }, 'body-framing'],
    [{ answer: () => ({ needsBody: true }) }, request, 'vault-reply'],
    [
      { answer: () => ({ mode: 'secret', head: { ...head, headers: [] } }) },
      request,
      'vault-reply',
    ],
    [{ answer: () => ({ mode: 'secret', head, body: bytes('x') }) }, request, 'vault-reply'],
    [{ answer: () => ({ mode: 'other', head }) }, request, 'vault-reply'],
    [{ answer: () => ({ mode: 'mcp', head }) }, request, 'vault-reply'],
    [
      { answer: () => ({ mode: 'mcp', head, bodyComplete: true, body: 'text' }) },
      { ...request, body: bytes('a') },
      'vault-reply',
    ],
    [
      {
        answer: (_, n) => (n === 1 ? { needsBody: true } : { mode: 'secret', head }),
      },
      { ...request, body: bytes('a') },
      'vault-reply',
    ],
  ];
  for (const [options, input, want] of cases) {
    assert.equal((await refusal(t, options, input)).cause, want, JSON.stringify(input.v));
  }
});

test('precondition refusals name users, the vault, the policy sync and the route, before the vault is asked', async (t) => {
  const cases = [
    [{}, { ...request, caller: { ...request.caller, users: 'report' } }, 'users-off'],
    [{ vault: { forwardEpoch: () => null } }, request, 'vault-unavailable'],
    [
      { vault: { forwardEpoch: () => null, forwardBlocked: () => 'vault-locked' } },
      request,
      'vault-locked',
    ],
    [{ ready: () => false }, request, 'policy-syncing'],
    [{ ready: () => false, unready: () => 'policy-missing' }, request, 'policy-missing'],
    [{ ready: () => false, unready: () => 'policy-unaccepted' }, request, 'policy-unaccepted'],
    [{ ready: () => false, unready: () => 'policy-unavailable' }, request, 'policy-unavailable'],
    [{ ready: () => false, unready: () => 'made-up' }, request, 'policy-syncing'],
    [{ select: () => null }, request, 'exit-not-credentialed'],
    [
      {
        select: (_, why) => {
          why('exit-tailnet');
          return null;
        },
      },
      request,
      'exit-tailnet',
    ],
    [
      {
        select: (_, why) => {
          why('made-up');
          return null;
        },
      },
      request,
      'exit-not-credentialed',
    ],
    [
      { selected: { rawTraits: { manualRedirects: false, encodedBodies: false } } },
      request,
      'exit-not-credentialed',
    ],
    [
      { selected: { rawTraits: { manualRedirects: true, encodedBodies: true } } },
      request,
      'exit-not-credentialed',
    ],
    [{ selected: { maxRequestBody: -1 } }, request, 'exit-not-credentialed'],
    [{ selected: { active: () => false } }, request, 'route-inactive'],
  ];
  for (const [options, input, want] of cases) {
    const { cause, asked } = await refusal(t, options, input);
    assert.equal(cause, want);
    assert.equal(asked.length, 0);
  }
});

test('a body larger than the route carries is refused as too large, whole, streamed or returned by the vault', async (t) => {
  const big = bytes('x'.repeat(2048));
  const options = { answer: () => ({ mode: 'secret', head }) };
  for (const input of [
    { ...request, body: big },
    { ...request, bodyStream: stream(big) },
  ])
    assert.equal((await refusal(t, options, input, 413)).cause, 'body-too-large');
  assert.equal(
    (
      await refusal(
        t,
        { answer: () => ({ mode: 'mcp', head, bodyComplete: true, body: big }) },
        { ...request, body: bytes('a') },
        413
      )
    ).cause,
    'body-too-large'
  );
});

test('the vault’s own cause reaches the client from an allow-list, never its reason text', async (t) => {
  const reason = `${SECRET} ${PLACEHOLDER} BB_TOKEN isn't a credential of the MCP server BB`;
  for (const cause of Object.keys(VAULT_CAUSES)) {
    const got = await refusal(t, { answer: () => ({ refused: { status: 403, reason, cause } }) });
    assert.equal(got.cause, cause);
  }
  for (const cause of [undefined, 'made-up', 'toString']) {
    const got = await refusal(t, { answer: () => ({ refused: { status: 403, reason, cause } }) });
    assert.equal(got.cause, 'vault-refused');
  }
  const later = await refusal(
    t,
    {
      answer: (_, n) =>
        n === 1
          ? { needsBody: true }
          : { refused: { status: 403, reason, cause: 'record-expired' } },
    },
    { ...request, body: bytes('{}') }
  );
  assert.equal(later.cause, 'record-expired');
  assert.equal(later.asked.length, 2);
});

test('a vault call that fails is refused as a vault error with its errno, or with its allowed cause', async (t) => {
  const failing = (error) => ({
    vault: {
      forward: async () => {
        throw error;
      },
    },
  });
  const f = forwarder(failing({ code: 'EINVAL', message: `bad ${SECRET}` }));
  t.after(f.close);
  await assert.rejects(f.run(), {
    cause: 'vault-error',
    message: `the credentialed request was refused (vault-error): ${FORWARD_CAUSES['vault-error']} (EINVAL)`,
  });
  const odd = forwarder(failing({ code: `E${SECRET}` }));
  t.after(odd.close);
  await assert.rejects(odd.run(), {
    message: `the credentialed request was refused (vault-error): ${FORWARD_CAUSES['vault-error']}`,
  });
  const paused = forwarder(failing(failure({ code: 'EACCES', cause: 'policy-paused' })));
  t.after(paused.close);
  await assert.rejects(paused.run(), { cause: 'policy-paused' });
});

test('a policy change while the vault prepares the request is refused as changed', async (t) => {
  let policy = 1;
  const f = forwarder({
    policyEpoch: () => policy,
    answer: () => {
      policy = 2;
      return { mode: 'secret', head };
    },
  });
  t.after(f.close);
  await assert.rejects(f.run(), { cause: 'changed', status: 403 });
});

test('the router names why a host has no credentialed route', () => {
  const base = {
    traits: { manualRedirects: true, encodedBodies: false, maxRequestBody: 1024 },
    active: () => true,
  };
  const why = (router, url, sender = base) => {
    let said;
    const selected = router.selectCredentialed(
      url,
      sender,
      () => false,
      (cause) => {
        said = cause;
      }
    );
    return selected ? 'selected' : said;
  };
  const plain = createExitRouter();
  assert.equal(why(plain, 'https://mcp.example.test/'), 'selected');
  assert.equal(why(plain, 'https://mcp.example.test/', null), 'extension-outdated');
  assert.equal(
    why(plain, 'https://mcp.example.test/', { active: () => true }),
    'exit-not-credentialed'
  );
  for (const url of [
    'http://localhost/',
    'https://slicc/',
    'http://169.254.169.254/',
    'http://1.kernel.localhost/',
  ])
    assert.equal(why(plain, url), 'destination-protected');
  assert.equal(plain.selectCredentialed('http://localhost/', base), null);
  const exit = (kind, extra = {}) => ({
    id: kind,
    kind,
    active: () => true,
    claims: () => true,
    offersDefault: () => true,
    prefixes: () => [],
    exitName: () => kind,
    ...extra,
  });
  for (const [kind, want] of [
    ['tailnet', 'exit-tailnet'],
    ['link', 'exit-link'],
    ['proxy', 'exit-not-credentialed'],
  ]) {
    const router = createExitRouter();
    router.add(exit(kind, kind === 'link' ? { credentialed: null } : {}));
    assert.equal(why(router, 'https://mcp.example.test/'), want);
  }
  const unnamed = createExitRouter();
  unnamed.add(exit('proxy', { credentialed: base, exitName: () => null }));
  assert.equal(why(unnamed, 'https://mcp.example.test/'), 'exit-not-credentialed');
});

test('the policy sync says why it is not ready: syncing, a missing file, not accepted, or unavailable', async () => {
  const sync = async (attest, call) => {
    const policy = createPolicySync({
      kernel: {
        users: { mode: 'enforce' },
        attest: async (path) => attest(path),
        watch: async () => () => {},
      },
      vault: { forwardEpoch: () => 1, port: { on: () => () => {} }, call },
    });
    assert.equal(policy.why(), 'policy-syncing');
    await policy.start();
    await policy.settled();
    const state = { ready: policy.ready(), why: policy.why() };
    policy.close();
    assert.equal(policy.why(), 'policy-syncing');
    return state;
  };
  const present = (path) => ({ path, sha256: 'a' });
  assert.deepEqual(await sync(present, async () => ({ accepted: true })), {
    ready: true,
    why: null,
  });
  assert.deepEqual(
    await sync(
      (path) => ({ path, absent: true }),
      async () => ({ accepted: true })
    ),
    { ready: false, why: 'policy-missing' }
  );
  assert.deepEqual(await sync(present, async () => ({ accepted: false })), {
    ready: false,
    why: 'policy-unaccepted',
  });
  assert.deepEqual(
    await sync(present, async () => {
      throw new Error('gone');
    }),
    { ready: false, why: 'policy-unavailable' }
  );
});

test('a vault call failure keeps only allowed causes', () => {
  assert.equal(
    failure({ code: 'EACCES', message: 'x', cause: 'policy-paused' }).cause,
    'policy-paused'
  );
  assert.equal(
    failure({ code: 'EACCES', message: 'x', cause: 'record-expired' }).cause,
    'record-expired'
  );
  assert.equal(failure({ code: 'EACCES', message: 'x', cause: SECRET }).cause, undefined);
});

test('the vault says whether forwarding is blocked by a lock or by no forwarding vault', () => {
  const state = (view) => {
    const { forwardEpoch, forwardBlocked } = forwardState(view, () => 3);
    return [forwardEpoch(), forwardBlocked()];
  };
  const forward = { capabilities: { forward: 1 } };
  assert.deepEqual(state({ welcomed: true, status: forward }), [3, 'vault-unavailable']);
  assert.deepEqual(state({ welcomed: true, status: { ...forward, locked: true } }), [
    null,
    'vault-locked',
  ]);
  assert.deepEqual(state({ welcomed: true, status: { capabilities: {} } }), [
    null,
    'vault-unavailable',
  ]);
  assert.deepEqual(state({ welcomed: false, status: null }), [null, 'vault-unavailable']);
});

test('a missing policy file the vault has paused lets the vault decide: MCP goes on, a secret is refused', async (t) => {
  const mcpHead = { ...head, url: request.url };
  const mcp = forwarder({
    ready: () => false,
    unready: () => 'policy-missing',
    paused: () => true,
    answer: () => ({ mode: 'mcp', head: mcpHead, bodyComplete: true }),
    selected: {
      fetch: async () => ({
        status: 200,
        statusText: 'OK',
        headers: [],
        url: request.url,
        body: (async function* () {})(),
        cancel: async () => {},
      }),
    },
  });
  t.after(mcp.close);
  const response = await mcp.run();
  assert.equal(response.status, 200);
  await response.cancel();
  assert.equal(mcp.asked.length, 1);
  const byVault = await refusal(t, {
    ready: () => false,
    unready: () => 'policy-missing',
    paused: () => true,
    answer: () => ({ refused: { status: 403, reason: 'paused', cause: 'policy-paused' } }),
  });
  assert.equal(byVault.cause, 'policy-paused');
  assert.equal(byVault.asked.length, 1);
  const secret = await refusal(t, {
    ready: () => false,
    unready: () => 'policy-missing',
    paused: () => true,
    answer: () => ({ mode: 'secret', head }),
  });
  assert.equal(secret.cause, 'policy-paused');
  const unpaused = await refusal(t, { ready: () => false, unready: () => 'policy-missing' });
  assert.equal(unpaused.cause, 'policy-missing');
  assert.equal(unpaused.asked.length, 0);
});

test('the policy sync lets the vault decide only when its accepted reply confirms every missing file as paused', async () => {
  const CONFIG = '/etc/fnox/config.toml';
  const EXTRA = '/etc/slicc/secrets-policy.toml';
  const present = (path) => ({ path, sha256: 'a' });
  const absent = (path) => ({ path, absent: true });
  const pausedFile = (path) => ({ path, sha256: null, accepted: true, absent: true, paused: true });
  const sync = async (attest, reply, status = []) => {
    const policy = createPolicySync({
      kernel: {
        users: { mode: 'enforce' },
        attest: async (path) => attest[path](path),
        watch: async () => () => {},
      },
      vault: {
        forwardEpoch: () => 1,
        port: { on: () => () => {}, status: () => ({ policy: status }) },
        call: async () => reply,
      },
    });
    assert.equal(policy.paused(), false);
    await policy.start();
    await policy.settled();
    const state = { ready: policy.ready(), why: policy.why(), paused: policy.paused() };
    policy.close();
    assert.equal(policy.paused(), false);
    return state;
  };
  const rejected = { path: CONFIG, sha256: 'a', accepted: false, warnings: ['not trusted'] };
  assert.deepEqual(
    await sync(
      { [CONFIG]: present, [EXTRA]: absent },
      { accepted: false, files: [rejected, pausedFile(EXTRA)] },
      [rejected, pausedFile(EXTRA)]
    ),
    { ready: false, why: 'policy-unaccepted', paused: false },
    'a rejected file and a paused missing one'
  );
  assert.deepEqual(
    await sync({ [CONFIG]: present, [EXTRA]: present }, { accepted: false, files: [rejected] }),
    { ready: false, why: 'policy-unaccepted', paused: false },
    'a rejected file alone'
  );
  assert.deepEqual(
    await sync(
      { [CONFIG]: present, [EXTRA]: absent },
      { accepted: true, files: [{ path: CONFIG, accepted: true }, pausedFile(EXTRA)] }
    ),
    { ready: false, why: 'policy-missing', paused: true },
    'a missing file the reply confirms paused'
  );
  assert.deepEqual(
    await sync(
      { [CONFIG]: absent, [EXTRA]: absent },
      { accepted: true, files: [pausedFile(CONFIG), pausedFile(EXTRA)] }
    ),
    { ready: false, why: 'policy-missing', paused: true },
    'both missing and confirmed paused'
  );
  assert.deepEqual(
    await sync(
      { [CONFIG]: absent, [EXTRA]: absent },
      { accepted: true, files: [pausedFile(EXTRA)] },
      [pausedFile(CONFIG), pausedFile(EXTRA)]
    ),
    { ready: false, why: 'policy-missing', paused: false },
    'a missing file this reply does not confirm, whatever the status says'
  );
  assert.deepEqual(
    await sync(
      { [CONFIG]: present, [EXTRA]: absent },
      { accepted: true, files: [{ path: EXTRA, absent: true, accepted: true }] },
      [pausedFile(EXTRA)]
    ),
    { ready: false, why: 'policy-missing', paused: false },
    'a missing file the reply shows unpaused'
  );
  assert.deepEqual(
    await sync({ [CONFIG]: present, [EXTRA]: absent }, { accepted: true }),
    { ready: false, why: 'policy-missing', paused: false },
    'a reply without files'
  );
  assert.deepEqual(
    await sync(
      { [CONFIG]: present, [EXTRA]: present },
      { accepted: true, files: [pausedFile(EXTRA)] }
    ),
    { ready: true, why: null, paused: false },
    'nothing missing'
  );
});

async function pausedSeven(t, { answer } = {}) {
  const CONFIG = '/etc/fnox/config.toml';
  const EXTRA = '/etc/slicc/secrets-policy.toml';
  const statusListeners = new Set();
  const paused = { path: EXTRA, sha256: null, accepted: true, absent: true, paused: true };
  const sends = [];
  const asked = [];
  const ports = [];
  const vault = {
    forwardEpoch: () => 1,
    port: {
      on: (type, listener) => {
        if (type !== 'status') return () => {};
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      status: () => null,
    },
    call: async () => ({ accepted: true, files: [{ path: CONFIG, accepted: true }, paused] }),
    async forward(input, port) {
      asked.push(input);
      ports.push(port);
      port.onmessage = ({ data }) => {
        if (data.op === 'body') {
          port.postMessage(data);
          port.postMessage({ op: 'credit', bytes: data.chunk.byteLength });
        } else port.postMessage(data);
      };
      port.start();
      return answer ? answer() : { mode: 'mcp', head, bodyComplete: true };
    },
  };
  const policy = createPolicySync({
    kernel: {
      users: { mode: 'enforce' },
      attest: async (path) => (path === EXTRA ? { path, absent: true } : { path, sha256: 'a' }),
      watch: async () => () => {},
    },
    vault,
  });
  await policy.start();
  await policy.settled();
  for (const listener of [...statusListeners]) listener({ policy: [paused] });
  await policy.settled();
  assert.equal(policy.paused(), true);
  t.after(() => {
    policy.close();
    for (const port of ports) port.close();
  });
  const forward = createForwarder({
    vault,
    select: () => ({
      exit: 'page',
      rawTraits: { manualRedirects: true, encodedBodies: false },
      maxRequestBody: 1024,
      active: () => true,
      fetch: async (sent) => {
        sends.push(sent);
        return {
          status: 200,
          statusText: 'OK',
          headers: [],
          url: request.url,
          body: (async function* () {})(),
          cancel: async () => {},
        };
      },
    }),
    ready: policy.ready,
    unready: policy.why,
    paused: policy.paused,
    policyEpoch: policy.epoch,
    onPolicyChange: policy.onChange,
  });
  const status = (policyFiles) => {
    for (const listener of [...statusListeners]) listener({ policy: policyFiles });
  };
  const run = () => forward(request, { signal: new AbortController().signal });
  return { policy, run, status, sends, asked, paused };
}

test('a later status that no longer shows the pause ends the MCP exception at once', async (t) => {
  const seven = await pausedSeven(t);
  seven.status([{ path: '/etc/fnox/config.toml', sha256: 'a', accepted: true }]);
  assert.equal(seven.policy.paused(), false);
  await assert.rejects(seven.run(), { cause: 'policy-syncing' });
  assert.equal(seven.asked.length, 0);
  assert.equal(seven.sends.length, 0);
});

test('a status that ends the pause while a forward is prepared stops it before it is sent', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const seven = await pausedSeven(t, {
    answer: async () => {
      entered.resolve();
      await release.promise;
      return { mode: 'mcp', head, bodyComplete: true };
    },
  });
  const pending = seven.run();
  await entered.promise;
  seven.status([]);
  release.resolve();
  await assert.rejects(pending);
  assert.equal(seven.sends.length, 0);
});

test('a status that still shows the pause keeps the MCP exception', async (t) => {
  const seven = await pausedSeven(t);
  seven.status([seven.paused]);
  assert.equal(seven.policy.paused(), true);
  const response = await seven.run();
  assert.equal(response.status, 200);
  await response.cancel();
  assert.equal(seven.sends.length, 1);
});
