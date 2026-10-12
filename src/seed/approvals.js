const CHANNEL = 'slicc-approvals';
const SAFE = /^[\w@%+=:,./-]+$/;

export function quote(word) {
  return SAFE.test(word) ? word : `'${String(word).replaceAll("'", `'\\''`)}'`;
}

export function requester({ user, tag }) {
  let parsed = null;
  try {
    parsed = JSON.parse(tag);
  } catch {}
  if (parsed?.kind === 'agent' && typeof parsed.agentId === 'string') {
    return { kind: 'agent', name: user, agentId: parsed.agentId };
  }
  if (parsed?.kind === 'user' && typeof parsed.where === 'string') {
    const where = parsed.where.startsWith('terminal:') ? 'a terminal' : parsed.where;
    return { kind: 'user', name: user, where };
  }
  return { kind: 'user', name: user };
}

export function approval(req) {
  return {
    id: String(req.id),
    kind: 'sudo',
    requester: requester(req),
    command: [req.path ?? req.argv[0], ...req.argv.slice(1)].map(quote).join(' '),
    target: req.target,
    cwd: req.cwd,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
    always: req.always !== false,
  };
}

function emitter() {
  const listeners = new Map();
  return {
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    emit(type, value) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(value);
    },
  };
}

export function createApprovals({ channel = new BroadcastChannel(CHANNEL) } = {}) {
  const events = emitter();
  const waiting = new Map();
  const mine = new Set();
  let shown = [];
  let owning = false;
  const show = (list) => {
    shown = list;
    events.emit('approvals', shown);
  };
  const end = (id, reason) => {
    if (!shown.some((item) => item.id === id)) return;
    show(shown.filter((item) => item.id !== id));
    const decided = mine.delete(id);
    if (!decided || reason !== 'answered') events.emit('ended', { id, reason });
  };
  const publish = () => {
    const list = [...waiting.values()].map(({ item }) => item);
    show(list);
    channel.postMessage({ list });
  };
  const settle = (id, decision, reason) => {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    entry.resolve(decision);
    end(id, reason);
    channel.postMessage({ ended: { id, reason } });
    publish();
  };
  channel.onmessage = ({ data }) => {
    if (owning && data?.hello) publish();
    else if (owning && data?.decide) settle(data.decide.id, data.decide.decision, 'answered');
    else if (!owning && data?.list) show(data.list);
    else if (!owning && data?.ended) end(data.ended.id, data.ended.reason);
  };
  channel.postMessage({ hello: true });
  return {
    port: {
      on: events.on,
      list: () => shown,
      async decide(id, decision) {
        mine.add(id);
        if (owning) settle(id, decision, 'answered');
        else channel.postMessage({ decide: { id, decision } });
      },
    },
    own() {
      owning = true;
      publish();
    },
    approve(req, { signal } = {}) {
      const item = approval(req);
      return new Promise((resolve) => {
        waiting.set(item.id, { item, resolve });
        publish();
        signal?.addEventListener('abort', () =>
          settle(item.id, 'deny', signal.reason === 'expired' ? 'expired' : 'withdrawn')
        );
      });
    },
  };
}
