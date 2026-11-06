import { followerDevice } from './tags.js';
import { agentFor } from './users.js';

export const REST_MS = 10_000;
export const DISMISSED_ASK = 'another request was just dismissed';
export const UNSHOWN = "seven can't show this request yet; update seven";
export const IN_FRAME = "Save or Allow in the vault's frame.";
const CONTROL = /\p{Cc}/gu;
const ENDED = { withdrawn: 'withdrawn', expired: 'expired' };

export const clean = (text) => String(text).replace(CONTROL, '').slice(0, 128);

function tagOf(caller) {
  try {
    return JSON.parse(caller?.tag);
  } catch {
    return null;
  }
}

function placeOf(tag, caller, device) {
  if (tag?.kind === 'agent')
    return typeof tag.agentId === 'string' ? tag.agentId.replace(/^cone:/, '') : undefined;
  if (tag?.kind !== 'user') return agentFor(caller?.user) ? caller.user : undefined;
  if (typeof tag.where !== 'string') return undefined;
  if (tag.where.startsWith('terminal:')) return 'a terminal';
  const linked = followerDevice(caller.tag);
  return linked ? (device(linked) ?? 'on a linked device') : tag.where;
}

export function askedBy(caller, device = () => undefined) {
  const tag = tagOf(caller);
  const agent = tag?.kind === 'agent' || (tag?.kind !== 'user' && agentFor(caller?.user) !== null);
  const where = placeOf(tag, caller, device);
  return {
    kind: agent ? 'agent' : 'user',
    name: clean(typeof caller?.user === 'string' ? caller.user : `uid ${caller?.uid}`),
    ...(where ? { where: clean(where) } : {}),
  };
}

const session = (stamp) =>
  JSON.stringify([stamp?.uid ?? null, stamp?.tag ?? null, stamp?.tags ?? []]);

export function resting({ now = Date.now, rest = REST_MS } = {}) {
  const until = new Map();
  return {
    busy(caller) {
      const key = session(caller);
      if (!until.has(key)) return false;
      if (until.get(key) > now()) return true;
      until.delete(key);
      return false;
    },
    dismissed(caller) {
      until.set(session(caller), now() + rest);
    },
  };
}

const refusal = (code, message) => ({ v: 1, error: { code, message } });

export function askRelay({ call, device = () => undefined, shows = () => true, rest = resting() }) {
  return async (req, caller, signal) => {
    if (!shows()) return refusal('EACCES', UNSHOWN);
    if (rest.busy(caller)) return refusal('EACCES', DISMISSED_ASK);
    let request = null;
    let gone = false;
    const withdraw = () =>
      void call('cancel', { request, reason: 'withdrawn' }).catch(() => undefined);
    const asked = (id) => {
      request = id;
      if (gone) withdraw();
    };
    const leave = () => {
      gone = true;
      if (request) withdraw();
    };
    signal?.addEventListener?.('abort', leave, { once: true });
    const requester = { ...req.requester, ...askedBy(caller, device) };
    try {
      const { reply } = await call(
        'sealed',
        { req: { ...req, requester }, stamp: caller },
        { signal, dropAway: true, held: true, asked }
      );
      if (reply?.state === 'cancelled') rest.dismissed(caller);
      return reply;
    } catch (error) {
      return refusal(error.code, error.message);
    } finally {
      signal?.removeEventListener?.('abort', leave);
    }
  };
}

export function secretApproval(pending) {
  const { requester = {} } = pending;
  return {
    id: String(pending.id),
    kind: 'secret',
    mode: pending.mode === 'reveal' ? 'reveal' : 'enter',
    name: pending.name,
    ...(typeof pending.prompt === 'string' ? { prompt: pending.prompt } : {}),
    reveal: pending.reveal === true,
    requester: {
      kind: requester.kind === 'agent' ? 'agent' : 'user',
      name: requester.name ?? `uid ${pending.uid}`,
      ...(typeof requester.where === 'string' ? { where: requester.where } : {}),
    },
    process: { exe: requester.exe, argv: requester.argv ?? [], cwd: requester.cwd },
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  };
}

const asksIn = (status) =>
  (status?.waiting ?? []).filter((item) => item?.kind === 'ask').map(secretApproval);

export const SETTLE_MS = 1000;

export function secretApprovals(vault, { now = Date.now, timers = globalThis } = {}) {
  const listeners = { approvals: new Set(), ended: new Set() };
  const mine = new Set();
  const states = new Map();
  const framed = new Set();
  const settling = new Map();
  let shown = asksIn(vault.status());
  const emit = (type, value) => {
    for (const listener of [...listeners[type]]) listener(value);
  };
  const answered = (id) => {
    const timer = settling.get(id);
    if (timer === undefined) return;
    settling.delete(id);
    timers.clearTimeout(timer);
    emit('ended', { id, reason: 'answered' });
  };
  const end = (item) => {
    const state = states.get(item.id);
    states.delete(item.id);
    const framing = framed.delete(item.id);
    if (mine.delete(item.id)) return;
    const reason = ENDED[state] ?? (item.expiresAt <= now() ? 'expired' : 'answered');
    if (reason !== 'answered' || !framing) return emit('ended', { id: item.id, reason });
    settling.set(
      item.id,
      timers.setTimeout(() => answered(item.id), SETTLE_MS)
    );
  };
  vault.on('cancelled', ({ request, state }) => states.set(String(request), state));
  vault.on('status', (status) => {
    const next = asksIn(status);
    const ids = new Set(next.map((item) => item.id));
    const gone = shown.filter((item) => !ids.has(item.id));
    shown = next;
    emit('approvals', shown);
    for (const item of gone) end(item);
  });
  return {
    has: (id) => shown.some((item) => item.id === id),
    list: () => shown,
    on(type, listener) {
      if (!Object.hasOwn(listeners, type)) return () => undefined;
      listeners[type].add(listener);
      return () => listeners[type].delete(listener);
    },
    framed(id) {
      if (shown.some((item) => item.id === id)) framed.add(id);
    },
    heard(id, event) {
      if (event === 'gone') {
        framed.delete(id);
        return answered(id);
      }
      if (event !== 'done') return;
      const timer = settling.get(id);
      settling.delete(id);
      timers.clearTimeout(timer);
      if (timer === undefined && shown.some((item) => item.id === id)) mine.add(id);
    },
    async decide(id, decision) {
      if (decision !== 'deny') throw new Error(IN_FRAME);
      mine.add(id);
      try {
        await vault.cancel(id);
      } catch (error) {
        mine.delete(id);
        throw error;
      }
    },
  };
}

const both = (stops) => () => {
  for (const stop of stops) stop();
};

export function withSecrets(port, vault, options = {}) {
  const secrets = secretApprovals(vault, options);
  const list = () => [...port.list(), ...secrets.list()];
  return {
    port: {
      ...port,
      list,
      on(type, listener) {
        const heard = type === 'approvals' ? () => listener(list()) : listener;
        return both([port.on(type, heard), secrets.on(type, heard)]);
      },
      decide: (id, decision) =>
        secrets.has(id) ? secrets.decide(id, decision) : port.decide(id, decision),
    },
    vault: {
      ...vault,
      valueFrame(request) {
        const id = String(request);
        const frame = vault.valueFrame(request);
        secrets.framed(id);
        const stop = frame.listen((event) => {
          if (String(event.request) !== id) return;
          secrets.heard(id, event.event);
          if (event.event === 'done' || event.event === 'gone') stop();
        });
        return frame;
      },
    },
  };
}
