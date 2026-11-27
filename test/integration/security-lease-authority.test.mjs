import './lease-enabled-seed.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { bootLeaseJob, createLeaseJob } = await import('../../src/seed/lease-job.js');
const { leaseFollowers } = await import('../../src/seed/lease-peer.js');
const { proposal } = await import('../../src/seed/lease-scope.js');
const { b64, records } = await import('../../src/seed/lease-wire.js');
const { createLeaseTray } = await import('../../src/seed/tray.js');

const origin = 'https://billing.example';
const allow = [{ kind: 'origin', url: origin }];
const initial = { allow, ttlSeconds: 60 };
const ctx = { stamp: { tag: 'one' }, signal: new AbortController().signal };
const unsupported = { reason: 'E_UNSUPPORTED' };
const revoked = { reason: 'E_REVOKED' };

function wait(job, key, value) {
  return new Promise((resolve) => {
    const check = () => {
      if (job.status()[key] === value) {
        off();
        resolve();
      }
    };
    const off = job.on(check);
    check();
  });
}

async function issuer(jkt) {
  const signer = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const pack = (v) => b64(new TextEncoder().encode(JSON.stringify(v)));
  const claims = {
    iss: 'fixture',
    aud: 'fixture-browser',
    browser_session: 'fixture-epoch',
    cnf: { jkt },
    allow,
  };
  return async () => {
    const input = `${pack({ typ: 'slicc-cdp-lease+jwt', alg: 'Ed25519' })}.${pack({ ...claims, jti: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 60 })}`;
    return `${input}.${b64(await crypto.subtle.sign('Ed25519', signer.privateKey, new TextEncoder().encode(input)))}`;
  };
}

function peer() {
  const modes = [],
    actions = [];
  let request, stream;
  return {
    modes,
    actions,
    approve: (jwt) => request.emit({ type: 'grant', request: 'R', jwt }),
    loseEpoch: () => stream.close('E_REVOKED'),
    session: {
      close() {},
      async open({ mode }) {
        modes.push(mode);
        const queue = new TransformStream();
        const reader = queue.readable.getReader(),
          writer = queue.writable.getWriter();
        const inbox = records({
          write(bytes) {
            void writer.write(bytes).catch(() => {});
          },
        });
        const done = Promise.withResolvers();
        const wire = {
          info: { nonce: b64(crypto.getRandomValues(new Uint8Array(32))) },
          settled: done.promise,
          async read() {
            const { done, value } = await reader.read();
            return done ? null : value;
          },
          async write(frame) {
            const r = JSON.parse(new TextDecoder().decode(frame.subarray(4)));
            if (r.type === 'proof')
              return inbox.write(
                mode === 'request' ? { type: 'pending', request: 'R' } : { type: 'ready' }
              );
            actions.push(r.op);
            return inbox.write({
              type: 'result',
              id: r.id,
              result: r.op === 'snapshot' ? { text: 'invoice' } : {},
            });
          },
          emit: (r) => inbox.write(r),
          close(code) {
            done.resolve(code && { code });
            void reader.cancel().catch(() => {});
          },
          closeWrite() {
            wire.close();
          },
        };
        if (mode === 'request') request = wire;
        else stream = wire;
        return wire;
      },
    },
  };
}

async function active(t) {
  const job = await createLeaseJob('one');
  t.after(() => job.close());
  const request = await job.adapter.request(initial, ctx);
  const sign = await issuer(request.jkt),
    broker = peer();
  job.attach(broker.session);
  await wait(job, 'pending', 'R');
  broker.approve(await sign());
  await wait(job, 'active', request.lease);
  const run = (op, args = {}, lease = request.lease) =>
    job.adapter.action({ op, args, lease }, ctx);
  return { job, broker, run, lease: request.lease, sign };
}

test('a gated-on build still requires a lease kernel, protected hub and the job stamp', async (t) => {
  await assert.rejects(
    bootLeaseJob({ createKernel: assert.fail }, { root: {}, origin }),
    unsupported
  );
  assert.throws(
    () => createLeaseTray({ origin: 'http://untrusted.example' }),
    /protected tray hub/
  );
  const { job, lease } = await active(t);
  const foreign = await createLeaseJob('two');
  t.after(() => foreign.close());
  const other = { ...ctx, stamp: { tag: 'two' } };
  await assert.rejects(job.adapter.request(initial, other), revoked);
  await assert.rejects(job.adapter.action({ lease, op: 'snapshot', args: {} }, other), revoked);
  const req = await foreign.adapter.request(initial, other);
  assert.notEqual(req.lease, lease);
  await assert.rejects(foreign.adapter.action({ lease, op: 'snapshot', args: {} }, other), revoked);
});

test('a signed grant whose cnf.jkt names a different holder is refused before data OPEN', async (t) => {
  const job = await createLeaseJob('one');
  const other = await createLeaseJob('two');
  t.after(() => job.close());
  t.after(() => other.close());
  const otherCtx = { ...ctx, stamp: { tag: 'two' } };
  const request = await job.adapter.request(initial, ctx);
  const intended = await other.adapter.request(initial, otherCtx);
  assert.notEqual(request.jkt, intended.jkt);
  const jwt = await (await issuer(intended.jkt))();

  const wrong = peer();
  job.attach(wrong.session);
  await wait(job, 'pending', 'R');
  wrong.approve(jwt);
  await wait(job, 'pending', null);
  assert.equal(job.status().active, null, 'a grant bound to the other holder must not activate');
  assert.equal(job.status().denied, request.lease);
  await assert.rejects(
    job.adapter.action({ lease: request.lease, op: 'snapshot', args: {} }, ctx),
    {
      reason: 'E_UNAVAILABLE',
    }
  );
  assert.deepEqual(wrong.modes, ['request']);

  const right = peer();
  other.attach(right.session);
  await wait(other, 'pending', 'R');
  right.approve(jwt);
  await wait(other, 'active', intended.lease);
  assert.deepEqual(
    await other.adapter.action({ lease: intended.lease, op: 'snapshot', args: {} }, otherCtx),
    {
      result: { text: 'invoice' },
    }
  );
  assert.deepEqual(right.modes, ['request', 'data']);
});

test('only goto and snapshot reach the wire; URL bounds apply before and after serialization', async (t) => {
  const { run, broker } = await active(t);
  const limit = `${origin}/${'a'.repeat(2048 - origin.length - 1)}`;
  await assert.rejects(run('click', { ref: 'e1' }), unsupported);
  await assert.rejects(run('fill', { ref: 'e1', value: 'note' }), unsupported);
  await assert.rejects(run('goto', { url: limit + 'a' }), unsupported);
  await assert.rejects(run('goto', { url: limit.slice(0, -1) + 'é' }), unsupported);
  await assert.rejects(run('goto', { url: limit.slice(0, -2) + 'é' }), unsupported);
  assert.deepEqual(broker.modes, ['request']);
  assert.deepEqual(await run('goto', { url: limit }), { result: {} });
  assert.deepEqual(await run('snapshot'), { result: { text: 'invoice' } });
  assert.deepEqual(broker.actions, ['goto', 'snapshot']);
  const parent = { jti: 'L1', allow: [] };
  const delta = (url) => proposal({ lease: 'L1', allow: [{ kind: 'exact', url }] }, parent);
  assert.equal(delta(limit).allow[0].url, limit);
  assert.throws(() => delta(limit + 'a'), unsupported);
  assert.throws(() => proposal({ ...initial, allow: [...allow, ...allow] }), unsupported);
  assert.throws(
    () => proposal({ ...initial, allow: [{ kind: 'path-prefix', url: origin + '/' }] }),
    unsupported
  );
});

test('detachment retires the JWT and handle; even the same broker must approve a fresh request', async (t) => {
  const { job, run, broker, lease, sign } = await active(t);
  assert.deepEqual(await run('snapshot'), { result: { text: 'invoice' } });
  job.detach(broker.session);
  assert.equal(job.status().active, null);
  const again = peer();
  job.attach(again.session);
  await assert.rejects(run('snapshot'), revoked);
  assert.deepEqual(again.modes, []);
  const next = await job.adapter.request(initial, ctx);
  assert.notEqual(next.lease, lease);
  await wait(job, 'pending', 'R');
  await assert.rejects(run('snapshot', {}, next.lease), { reason: 'E_PENDING' });
  assert.deepEqual(again.modes, ['request']);
  again.approve(await sign());
  await wait(job, 'active', next.lease);
  await run('snapshot', {}, next.lease);
  assert.deepEqual(again.modes, ['request', 'data']);
});

test('an idle broker retirement signal clears local authority before another action', async (t) => {
  const { job, run, broker } = await active(t);
  await run('snapshot');
  broker.loseEpoch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.status().active, null);
  await assert.rejects(run('snapshot'), revoked);
  assert.deepEqual(broker.modes, ['request', 'data']);
});

class Channel extends EventTarget {
  readyState = 'open';
  send() {}
  close() {
    this.readyState = 'closed';
  }
}

test('matching signaled SDP but a different actual leaf cannot deliver a grant', async (t) => {
  const job = await createLeaseJob('one');
  t.after(() => job.close());
  const local = await job.adapter.request(initial, ctx);
  const cert = new Uint8Array([7]);
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', cert)).toHex();
  const jwt = await (await issuer(local.jkt))();
  const ch = new Channel(),
    pc = new EventTarget(),
    closed = Promise.withResolvers(),
    sent = Promise.withResolvers();
  let opened = 0;
  Object.assign(pc, {
    createDataChannel(label) {
      if (label === 'slicc.link.v1') return ch;
      opened++;
      throw new Error('unexpected request for a grant');
    },
    async createOffer() {
      return { sdp: 'offer' };
    },
    async setLocalDescription(d) {
      this.localDescription = d;
    },
    async setRemoteDescription() {},
    sctp: { transport: { getRemoteCertificates: () => [new Uint8Array([8])] } },
    close: () => closed.resolve(),
  });
  const attached = Promise.withResolvers();
  const peers = leaseFollowers({
    job: {
      ...job,
      attach(s) {
        job.attach(s);
        attached.resolve();
      },
    },
    broker: expected,
    certificate: {},
    makePeer: () => pc,
    refuse: assert.fail,
    relay: () => () => sent.resolve(),
    runtime: 'slicc-link/1',
  });
  t.after(() => peers.close());
  const m = { controllerId: 'C', bootstrapId: 'B', runtime: 'slicc-link/1', trust: 'full' };
  peers.join(m);
  await sent.promise;
  peers.answer({
    ...m,
    answer: { sdp: `a=fingerprint:sha-256 ${expected.match(/../g).join(':')}` },
  });
  ch.dispatchEvent(new Event('open'));
  ch.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ v: 1, role: 'node', caps: ['cdp-lease-v1'] }),
    })
  );
  assert.equal(
    await Promise.race([closed.promise.then(() => false), attached.promise.then(() => true)]),
    false
  );
  ch.dispatchEvent(
    new MessageEvent('message', { data: JSON.stringify({ type: 'grant', request: 'R', jwt }) })
  );
  assert.equal(opened, 0);
  assert.equal(job.status().active, null);
  await assert.rejects(job.adapter.action({ lease: local.lease, op: 'snapshot', args: {} }, ctx), {
    reason: 'E_PENDING',
  });
});
