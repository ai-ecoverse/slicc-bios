import { dialogRules } from './rules.js';

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

const READ_ONLY = new Set([
  'cat',
  'df',
  'diff',
  'du',
  'echo',
  'file',
  'grep',
  'head',
  'ls',
  'pwd',
  'readlink',
  'realpath',
  'stat',
  'tail',
  'tree',
  'wc',
]);
const RULES = ['/etc/fnox', '/etc/slicc/secrets-policy.toml'];
const PARENTS = ['/', '/etc', '/etc/slicc'];
const OPAQUE = /[*?[{$`~]|\.\.(\/|$)/;

function resolved(cwd, word) {
  const parts = (word.startsWith('/') ? word : `${cwd}/${word}`).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return `/${out.join('/')}`;
}

function words(argv) {
  return argv.flatMap((word) =>
    String(word)
      .split(/[\s;&|()<>=,'"]+/)
      .flatMap((part) => [part, ...(part.startsWith('-') ? [part.replace(/^-+[^/]*/, '')] : [])])
      .filter(Boolean)
  );
}

const STRICT = /[$`'"\\]/;

function cautious(argv) {
  const shell = argv.indexOf('-c');
  if (shell < 0) return false;
  return argv
    .slice(shell + 1)
    .some((word) => STRICT.test(word) || /(^|[\s;&|(])(cd|pushd)\s/.test(word));
}

export function secretRules(req) {
  const { argv = [] } = req;
  if (cautious(argv) || argv.slice(1).some((word) => /^[^-].*['"\\]|[$`]/.test(word))) return true;
  if (dialogRules(approvalText(req)) !== null) return true;
  return ownRules(req);
}

function approvalText(req) {
  const { argv = [], path, cwd } = req;
  return {
    command: [path ?? argv[0] ?? '', ...argv.slice(1)].map(quote).join(' '),
    cwd,
  };
}

function ownRules({ argv = [], path, cwd = '/' }) {
  const all = words([path ?? argv[0] ?? '', ...argv.slice(1)]);
  const name = String(path ?? argv[0] ?? '')
    .split('/')
    .pop();
  const reading = READ_ONLY.has(name);
  const inside = (at) => RULES.some((rule) => at === rule || at.startsWith(`${rule}/`));
  if (inside(resolved('/', cwd))) return true;
  for (const word of all.slice(1)) {
    if (/fnox|secrets-policy/.test(word)) return true;
    if (OPAQUE.test(word) && !reading) return true;
    const at = resolved(cwd, word);
    if (inside(at)) return true;
    if (!reading && PARENTS.includes(at)) return true;
  }
  return false;
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
    always: req.always !== false && !secretRules(req),
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
        waiting.set(item.id, {
          item,
          resolve: (decision) => resolve(decision === 'always' && !item.always ? 'once' : decision),
        });
        publish();
        signal?.addEventListener('abort', () =>
          settle(item.id, 'deny', signal.reason === 'expired' ? 'expired' : 'withdrawn')
        );
      });
    },
  };
}
