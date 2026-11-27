import { requireLeaseBuild } from './lease-peer.js';
import { actionFor, fail, grantFor, id, proposal, shape } from './lease-scope.js';
import { expect, holderKey, openLease, refusal } from './lease-wire.js';
import { createLeaseTray } from './tray.js';

function output(op, result) {
  if (op === 'snapshot' && shape(result, ['text']) && typeof result.text === 'string')
    return { result: { text: result.text } };
  if (op !== 'snapshot' && shape(result, [])) return { result: {} };
  fail('E_UNAVAILABLE');
}

function dataLane() {
  let channel, sequence, busy;
  return {
    clear() {
      channel?.close();
      channel = undefined;
    },
    async action(here, key, before, op, args, source, validate, failed) {
      if (busy || !here) fail('E_UNAVAILABLE');
      busy = true;
      const signal = AbortSignal.any([source, here.stop.signal, AbortSignal.timeout(30000)]);
      const check = () => {
        validate();
        signal.throwIfAborted();
      };
      let data = channel;
      const close = () => data?.close();
      signal.addEventListener('abort', close, { once: true });
      try {
        if (!data) {
          data = await openLease(here.session, key, { mode: 'data', jwt: before.jwt }, signal);
          check();
          expect(await data.read(), 'ready');
          check();
          channel = data;
          sequence = 0;
          data.settled.then((error) => {
            if (channel !== data) return;
            channel = undefined;
            if (error) failed(error);
          });
        }
        const n = ++sequence;
        await data.write({ type: 'action', id: n, op, args });
        const record = await data.read();
        check();
        const result = expect(record, 'result', n).result;
        return output(op, result);
      } catch (e) {
        const why = failed(e);
        if (channel !== data || why.reason !== 'E_SCOPE') {
          close();
          if (channel === data) channel = undefined;
        }
        throw why;
      } finally {
        signal.removeEventListener('abort', close);
        busy = false;
      }
    },
  };
}

function repeat(existing, offer, expansion) {
  if (JSON.stringify(offer) !== JSON.stringify(existing.offer)) fail('E_UNSUPPORTED');
  if (expansion && !existing.broker) fail('E_PENDING');
  return { ...existing.local, ...(existing.broker ? { request: existing.broker } : {}) };
}

async function registered(request, source) {
  const { ack, local } = request;
  if (ack) {
    const signal = AbortSignal.any([source, AbortSignal.timeout(30000)]);
    const cancel = () => {
      request.stop.abort();
      ack.resolve(null);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const remote = await ack.promise;
      if (!remote || signal.aborted) fail('E_UNAVAILABLE');
      return { ...local, request: remote };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  return { ...local };
}

export async function createLeaseJob(tag, { now = Date.now } = {}) {
  requireLeaseBuild();
  if (!id(tag)) fail('E_UNSUPPORTED');
  let key = await holderKey();
  let route, pending, active, denied, terminal, timer;
  const data = dataLane();
  const listeners = new Set();
  const changed = () => {
    for (const fn of listeners) fn();
  };
  function discard() {
    if (active) delete active.jwt;
    active = undefined;
    pending?.ack?.resolve(null);
    pending?.stop.abort();
    pending = undefined;
    clearTimeout(timer);
    data.clear();
  }
  function end(reason) {
    terminal = reason;
    discard();
    changed();
  }
  const authorize = (ctx) => {
    if (
      !key ||
      ctx?.stamp?.tag !== tag ||
      !(ctx.signal instanceof AbortSignal) ||
      ctx.signal.aborted
    )
      fail('E_REVOKED');
    if (active && now() / 1000 >= active.exp) end('E_EXPIRED');
    if (terminal) fail(terminal);
  };
  async function register(current, request) {
    if (!request || !current || request.route === current) return;
    request.route = current;
    let stream;
    const signal = AbortSignal.any([
      current.stop.signal,
      request.stop.signal,
      AbortSignal.timeout(5 * 60 * 1000),
    ]);
    const close = () => stream?.close();
    try {
      stream = await openLease(current.session, key, request.offer, signal);
      signal.throwIfAborted();
      signal.addEventListener('abort', close, { once: true });
      const ack = expect(await stream.read(), 'pending');
      if (!id(ack.request)) fail('E_UNAVAILABLE');
      request.broker = ack.request;
      request.ack?.resolve(ack.request);
      changed();
      const approved = expect(await stream.read(), 'grant');
      if (approved.request !== ack.request || signal.aborted || pending !== request)
        fail('E_UNAVAILABLE');
      const granted = grantFor(approved.jwt, key.jkt, request.offer, request.parent, now());
      stream.end();
      stream = undefined;
      data.clear();
      clearTimeout(timer);
      active = { ...granted, local: request.local, offer: request.offer };
      pending = undefined;
      denied = undefined;
      timer = setTimeout(() => end('E_EXPIRED'), granted.exp * 1000 - now());
      changed();
    } catch (e) {
      if (route === current && pending === request) {
        denied = { lease: request.local.lease, reason: refusal(e?.reason ?? e?.code).reason };
        request.ack?.resolve(null);
        pending = undefined;
        changed();
      }
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  }
  function detach(session) {
    if (route?.session !== session) return;
    const old = route;
    route = undefined;
    old.stop.abort();
    discard();
    denied = undefined;
    changed();
  }
  const adapter = {
    async request(params, ctx) {
      authorize(ctx);
      const expansion = params?.lease !== undefined;
      if (expansion && (!active || params.lease !== active.local.lease)) fail('E_REVOKED');
      const parent = expansion ? active : undefined;
      const offer = proposal(params, parent);
      if (pending || (active && !expansion)) return repeat(pending ?? active, offer, expansion);
      if (expansion && !route) fail('E_UNAVAILABLE');
      const local = { request: crypto.randomUUID(), lease: crypto.randomUUID(), jkt: key.jkt };
      const ack = expansion ? Promise.withResolvers() : null;
      const request = { parent, local, offer, ack, stop: new AbortController() };
      pending = request;
      void register(route, request);
      changed();
      return registered(request, ctx.signal);
    },
    async action(params, ctx) {
      authorize(ctx);
      if (!shape(params, ['lease', 'op', 'args']) || !id(params.lease)) fail('E_UNSUPPORTED');
      if (pending?.local.lease === params.lease) fail('E_PENDING');
      if (denied?.lease === params.lease) fail(denied.reason);
      if (!active || params.lease !== active.local.lease) fail('E_REVOKED');
      const args = actionFor(params.op, params.args, active);
      const before = active;
      return data.action(
        route,
        key,
        before,
        params.op,
        args,
        ctx.signal,
        () => {
          authorize(ctx);
          if (active !== before) fail('E_REVOKED');
        },
        (e) => {
          const why = refusal(terminal ?? e?.reason ?? e?.code);
          if (before === active && ['E_REVOKED', 'E_EXPIRED'].includes(why.reason)) {
            delete before.jwt;
            if (why.reason !== 'E_REVOKED' || pending?.parent !== before) discard();
            active = undefined;
            denied = { lease: before.local.lease, reason: why.reason };
            changed();
          }
          return why;
        }
      );
    },
  };
  return {
    adapter,
    status: () => ({
      pending: pending?.broker ?? null,
      active: active?.local.lease ?? null,
      denied: denied?.lease ?? null,
    }),
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    attach(session) {
      if (!key || route) return session.close('lease job unavailable');
      route = { session, stop: new AbortController() };
      void register(route, pending);
      changed();
    },
    detach,
    close() {
      end('E_REVOKED');
      key = undefined;
      const session = route?.session;
      if (session) {
        detach(session);
        session.close('lease job ended');
      }
      listeners.clear();
    },
  };
}

export async function bootLeaseJob(module, config) {
  requireLeaseBuild();
  const { root, origin, broker, certificate } = config;
  if (module?.CDP_LEASE_VERSION !== 1 || !root || !origin) fail('E_UNSUPPORTED');
  const tag = crypto.randomUUID();
  const job = await createLeaseJob(tag);
  const tray = createLeaseTray({ job, origin, broker, certificate });
  let kernel;
  const close = () => {
    job.close();
    tray.stop();
    kernel?.terminate();
  };
  try {
    kernel = await module.createKernel({
      root,
      metadata: false,
      media: false,
      ca: false,
      cdpLease: { tag, adapter: job.adapter },
    });
    const port = await kernel.connect({ tag });
    tray.start();
    return { port, tray, on: job.on, status: job.status, close };
  } catch (error) {
    close();
    throw error;
  }
}
