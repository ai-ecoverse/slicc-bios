import { createServer } from 'node:http';

const frame = (state) => `
const state = ${JSON.stringify(state)};
let logging = Promise.resolve();
const log = (entry) => {
  const body = JSON.stringify(entry);
  logging = logging.then(() => fetch('/log', { method: 'POST', body })).catch(() => null);
  return logging;
};
let version = state.version;
let locked = state.locked;
let policy = [];
let serial = 0;
const records = new Map((state.records ?? []).map((record) => [record.kind + '\\u0000' + record.name, record]));
serial = records.size;
const save = () => fetch('/records', { method: 'POST', body: JSON.stringify({ records: [...records.values()], version }) });
const pages = [];
const agents = [];
const requests = new Map();
const tickets = new Map();
const mint = () => 'fnox_proxy_' + String(++serial).padStart(24, '0');
const key = (kind, name) => kind + '\\u0000' + name;
const keep = (fields) => {
  const kind = fields.kind ?? 'secret';
  const found = records.get(key(kind, fields.name));
  const record = {
    ...found,
    kind,
    name: fields.name,
    value: fields.value,
    source: fields.source ?? 'settings',
    placeholder: found?.placeholder ?? mint(),
    ...(fields.provider ? { provider: fields.provider } : {}),
    ...(fields.server ? { server: fields.server } : {}),
    ...(fields.settings ? { settings: fields.settings } : {}),
    ...(fields.expiresAt ? { expiresAt: fields.expiresAt } : {}),
  };
  delete record.removedAt;
  records.set(key(kind, fields.name), record);
  return record;
};
if (!state.records) for (const name of state.secrets) keep({ name, value: 'dummy-value-' + name.toLowerCase() });
const live = () => [...records.values()].filter((record) => !record.removedAt);
const scrub = () => ({ needed: records.size > 0 || version > 0, version, ready: true });
const status = () => ({
  version: '1.20.0',
  protocol: 1,
  capabilities: { forward: 1 },
  origin: location.ancestorOrigins?.[0] ?? '',
  locked,
  lock: locked ? 'passkey' : 'auto',
  scrub: scrub(),
  waiting: [],
  exportedAt: null,
  backupReminder: live().some((record) => record.kind === 'secret') ? 'due' : null,
  policy,
});
const view = (record) => ({
  name: record.name,
  kind: record.kind,
  placeholder: record.placeholder,
  state: 'inert',
  source: record.source,
  sourceDevice: null,
  ...(record.provider ? { provider: record.provider } : {}),
  ...(record.server ? { server: record.server } : {}),
  ...(record.url ? { url: record.url } : {}),
  ...(record.pinned ? { pinned: true } : {}),
  ...(record.settings ? { settings: record.settings } : {}),
  ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  domains: [],
  rules: [],
  exec: false,
  createdAt: 1767225600000,
});
const audit = [...(state.audit ?? [])];
const audited = (entry) => audit.unshift({ seq: Math.max(0, ...audit.map((each) => each.seq ?? 0)) + 1, id: 'audit-' + Date.now(), at: Date.now(), uid: null, tag: null, ...entry });
const usable = (record) => record.kind === 'mcp' && record.server && record.source !== 'process' && record.server.length <= 124;
const list = () => ({
  secrets: live().map(view),
  mcp: live().filter(usable).map(({ name, server }) => ({ name, server, state: 'ready' })),
  refused: [],
  audit,
  auditMore: false,
  exits: { file: '/etc/slicc/secrets-policy.toml', sha256: null, restricted: [] },
});
const placeholders = () => live().map((record) => record.placeholder).sort();
const changed = () => {
  version += 1;
  save();
  for (const each of pages) each.postMessage({ v: 1, event: 'placeholders', placeholders: placeholders(), scrub: scrub() });
};
const announce = () => {
  for (const each of pages) {
    each.postMessage({ v: 1, event: 'status', status: status() });
    each.postMessage({ v: 1, event: 'changed', parts: ['secrets'] });
  }
};
const fill = (text, kinds) => {
  let out = text;
  for (const record of live()) if (kinds.includes(record.kind)) out = out.split(record.placeholder).join(record.value);
  return out;
};
const hide = (text) => {
  let out = text;
  for (const record of records.values()) out = out.split(record.value).join(record.placeholder);
  return out;
};
const page = (port) => (event) => {
  const { id, op } = event.data;
  log({ role: 'page', op, name: event.data.name, sealed: event.data.req?.op, stamp: Boolean(event.data.stamp) });
  if (event.data.stamp) log({ role: 'stamp', op: event.data.req?.op ?? op, uid: event.data.stamp.uid, users: event.data.stamp.users ?? null, groups: event.data.stamp.groups ?? null });
  if (holding.includes(op)) return;
  const reply = (fields) => port.postMessage({ v: 1, id, op, ...fields });
  const refuse = () => port.postMessage({ v: 1, id, error: { code: 'EACCES', message: 'vault is locked: unlock it in the vault window' } });
  const result = (record) => ({ name: record.name, placeholder: record.placeholder, state: record.removedAt ? 'removed' : 'inert' });
  if (op === 'status') return reply({ status: status() });
  if (op === 'policy') {
    const files = event.data.files;
    const accepted = Array.isArray(files) && files.length === 2 && files.every((file) => file.users === 'enforce' && file.onRootFs === true && file.absent !== true);
    policy = Array.isArray(files) ? files.map((file) => ({ path: file.path, sha256: file.sha256 ?? null, accepted, warnings: [], ...(file.absent === true ? { absent: true, paused: true } : {}) })) : [];
    reply({ accepted, files: policy });
    return announce();
  }
  if (op === 'forward') {
    event.ports[0]?.close();
    return reply({ refused: { status: 403, reason: 'the fixture does not admit HTTP forwarding' } });
  }
  if (op === 'list') return reply({ list: list() });
  if (op === 'audit') return reply({ audit, more: false });
  if (op === 'placeholders') return reply({ placeholders: placeholders(), scrub: scrub() });
  if (op === 'sealed' && event.data.req?.op === 'seal') {
    if (locked) return reply({ reply: { v: 1, error: { code: 'EACCES', message: 'vault is locked' } } });
    const record = keep({ name: event.data.req.name, value: event.data.req.value, source: 'process' });
    changed();
    reply({ reply: { v: 1, placeholder: record.placeholder, state: 'inert' } });
    return announce();
  }
  if (op === 'sealed' && event.data.req?.op === 'placeholder') {
    const record = records.get(key('secret', event.data.req.name));
    return reply({
      reply: record
        ? { v: 1, placeholder: record.placeholder, state: record.removedAt ? 'removed' : 'inert' }
        : { v: 1, error: { code: 'ENOENT', message: 'no record named ' + event.data.req.name } },
    });
  }
  if (op === 'sealed' && event.data.req?.op === 'materialize') {
    const granted = event.data.req.shellGrants ? live().filter((record) => record.kind === 'secret' && record.exec === 'shell').map((record) => record.name) : [];
    const names = [...new Set([...(event.data.req.names ?? []), ...granted])];
    const ticket = String(tickets.size + 1).padStart(32, '0');
    tickets.set(ticket, names);
    log({ role: 'page', op: 'materialized', names, path: event.data.req.path, uid: event.data.stamp?.uid });
    const real = Object.fromEntries(names.map((name) => [name, records.has(key('secret', name))]));
    return reply({ reply: { v: 1, ticket, expiresAt: Date.now() + 30000, real } });
  }
  if (op === 'materializeConsume') {
    const names = tickets.get(event.data.ticket);
    tickets.delete(event.data.ticket);
    log({ role: 'page', op: 'consumed', ticket: event.data.ticket, ok: Boolean(names), resolved: event.data.resolved ?? null });
    if (!names) return port.postMessage({ v: 1, id, error: { code: 'EACCES', message: 'ticket refused: unknown ticket' } });
    const found = names.map((name) => records.get(key('secret', name))).filter(Boolean);
    return reply({
      values: Object.fromEntries(found.map((record) => [record.name, record.value])),
      placeholders: Object.fromEntries(found.map((record) => [record.name, record.placeholder])),
    });
  }
  if (op === 'sessionAnchors') {
    log({ role: 'page', op: 'anchors', fields: Object.keys(event.data).sort(), stamp: event.data.stamp, host: event.data.host, exit: event.data.exit });
    const known = (state.anchors ?? {})[event.data.host];
    if (!known) return port.postMessage({ v: 1, id, error: { code: 'EACCES', message: 'no session rule for ' + event.data.host } });
    return reply({ anchors: known.anchors, pins: known.pins });
  }
  if (op === 'sessionMaterialize') {
    log({ role: 'page', op: 'session', fields: Object.keys(event.data).sort(), stamp: event.data.stamp, session: event.data.session, host: event.data.host, head: event.data.head ?? null, verifiedBy: event.data.verifiedBy ?? null, anchor: event.data.anchor ?? null, scram: event.data.scram ?? null });
    if (locked) return refuse();
    const asked = Array.isArray(event.data.placeholders) ? event.data.placeholders : [];
    const found = live().filter((record) => record.kind === 'secret' && asked.includes(record.placeholder));
    if (!found.length) return port.postMessage({ v: 1, id, error: { code: 'EACCES', message: 'a placeholder of no record of this vault' } });
    return reply({ values: Object.fromEntries(found.map((record) => [record.placeholder, record.value])) });
  }
  if (op === 'sealed' && event.data.req?.op === 'request') {
    const id = 'req-' + String(requests.size + 1);
    requests.set(id, { kind: event.data.req.kind, state: 'pending' });
    return reply({ reply: { v: 1, state: 'pending', id } });
  }
  if (op === 'sealed' && event.data.req?.op === 'cancel') {
    const found = requests.get(event.data.req.id);
    if (found) {
      found.state = 'cancelled';
      for (const each of pages) each.postMessage({ v: 1, event: 'cancelled', request: event.data.req.id, kind: found.kind });
    }
    return reply({ reply: { v: 1, state: found?.state ?? 'expired' } });
  }
  if (op === 'sealed' && event.data.req?.op === 'status')
    return reply({ reply: { v: 1, ...(requests.get(event.data.req.id) ?? { state: 'expired' }) } });
  if (op === 'answer') {
    const { v: _v, id: _id, op: _op, request, state: answered, ...fields } = event.data;
    const found = requests.get(request);
    log({ role: 'page', op: 'answered', request, state: answered, fields });
    if (!found || found.state !== 'pending') return port.postMessage({ v: 1, id, error: { code: 'EINVAL', message: 'the request ended' } });
    Object.assign(found, fields);
    if (answered === 'done') found.state = 'done';
    return reply({ state: found.state });
  }
  if (op === 'sealed') return reply({ reply: { v: 1, secrets: live().filter((record) => record.kind === 'secret').map((record) => ({ name: record.name, placeholder: record.placeholder, state: 'inert', exec: record.exec ?? false, rules: [] })) } });
  if (op === 'remove' || op === 'restore') {
    const record = records.get(key(event.data.kind ?? 'secret', event.data.name));
    if (!record) return port.postMessage({ v: 1, id, error: { code: 'ENOENT', message: 'no record named ' + event.data.name } });
    if (op === 'remove') record.removedAt = Date.now();
    else delete record.removedAt;
    changed();
    reply(result(record));
    return announce();
  }
  if (op === 'endpoints') {
    const { v: _v, id: _id, op: _op, ...fields } = event.data;
    log({ role: 'page', op: 'endpoints-fields', fields });
    const unknown = Object.keys(fields).find((field) => !['model', 'mcp', 'remove', 'unpin'].includes(field));
    if (unknown) return port.postMessage({ v: 1, id, error: { code: 'EINVAL', message: 'endpoints has no field ' + unknown } });
    const entries = [...(fields.model ?? []), ...(fields.mcp ?? []), ...(fields.remove?.model ?? []), ...(fields.remove?.mcp ?? [])];
    const bad = entries.find((entry) => {
      try {
        const url = new URL(entry.url);
        return url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hostname.includes('*');
      } catch {
        return true;
      }
    });
    if (bad) return port.postMessage({ v: 1, id, error: { code: 'EINVAL', message: bad.url + ' must be an https: URL on port 443 without credentials or wildcards' } });
    for (const { server, url } of fields.mcp ?? [])
      for (const record of live()) if (record.kind === 'mcp' && record.server === server) Object.assign(record, { url, pinned: false });
    for (const name of fields.unpin ?? []) {
      const record = records.get(key('mcp', name));
      if (record) {
        record.pinned = false;
        delete record.url;
      }
      audited({ type: 'endpoints', unpinned: { name, server: record?.server ?? null, host: null } });
    }
    if (fields.mcp?.length) audited({ type: 'endpoints', adopted: fields.mcp.map(({ server, url }) => ({ server, host: new URL(url).host })) });
    reply({ ok: true });
    return announce();
  }
  if ((op === 'import' || op === 'export') && locked) return refuse();
  if (op === 'dismissBackupReminder') return reply({ backupReminder: 'dismissed' });
  if (op === 'put' && !('value' in event.data)) {
    if (locked) return refuse();
    log({ role: 'page', op: 'settings-put', fields: Object.keys(event.data).filter((field) => !['v', 'id', 'op'].includes(field)).sort() });
    const found = records.get(key(event.data.kind ?? 'secret', event.data.name));
    if (!found || found.removedAt || !['model', 'mcp'].includes(found.kind)) return port.postMessage({ v: 1, id, error: { code: 'ENOENT', message: 'no live model or mcp record named ' + event.data.name } });
    for (const field of ['provider', 'server', 'settings']) if (field in event.data) found[field] = event.data[field];
    save();
    reply(result(found));
    return announce();
  }
  if (op === 'put' || op === 'seal') {
    if (locked) return refuse();
    const record = keep(event.data);
    changed();
    reply(result(record));
    return announce();
  }
  return port.postMessage({ v: 1, id, error: { code: 'ENOTSUP', message: op + ' arrives later' } });
};
let egressed = null;
let muted = state.mute === true;
let holding = state.hold ?? [];
setInterval(async () => {
  const shared = await (await fetch('/state')).json();
  muted = shared.mute === true;
  holding = shared.hold;
  if (shared.egress && shared.egress.id !== egressed && pages.length) {
    egressed = shared.egress.id;
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      log({ role: 'egress', id: egressed, status: data.status ?? null, error: data.error ?? null });
      channel.port1.close();
    };
    pages.at(-1).postMessage({ v: 1, event: 'egress', request: shared.egress.request }, [channel.port2]);
  }
  const wanted = shared.locked;
  if (wanted === locked) return;
  locked = wanted;
  for (const each of pages) each.postMessage({ v: 1, event: 'status', status: status() });
  for (const release of agents) release();
}, 200);
addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.type !== 'slicc-vault' || event.data.op !== 'hello') return;
  if (muted) return;
  const port = event.ports[0];
  const role = event.data.role ?? 'page';
  log({ role, op: 'hello', origin: event.origin, sudoGid: event.data.sudoGid ?? null });
  if (role === 'page') {
    pages.push(port);
    port.onmessage = page(port);
  } else {
    const held = [];
    const answer = (data) => {
      const reply = (fields) => port.postMessage({ v: 1, id: data.id, op: data.op, ...fields });
      const prepare = (kinds) => {
        const request = { ...data.request, url: fill(data.request.url, kinds), headers: data.request.headers.map(([name, value]) => [name, fill(value, kinds)]) };
        return reply({ request, hits: [], version });
      };
      if (data.op === 'redact') return reply({ texts: data.texts.map((text) => (typeof text === 'string' ? hide(text) : text)), hits: [], version });
      if (data.op === 'records') return reply({ records: live().filter((record) => record.kind === 'model' || record.kind === 'mcp').map((record) => ({ kind: record.kind, name: record.name, placeholder: record.placeholder, state: 'ready', ...(record.provider ? { provider: record.provider } : {}), ...(record.server ? { server: record.server } : {}), ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) })) });
      if (data.op === 'endpoints') return reply({ ok: true });
      if (data.op === 'grant' && data.provider) {
        log({ role: 'agent', op: 'grant-fields', provider: data.provider, name: data.name, fields: Object.keys(data).filter((field) => !['v', 'id', 'op'].includes(field)).sort(), bytes: data.response instanceof Uint8Array });
        if (!(data.response instanceof Uint8Array)) return port.postMessage({ v: 1, id: data.id, op: data.op, error: { code: 'EINVAL', message: 'response must be bytes' } });
        let token;
        try {
          token = JSON.parse(new TextDecoder().decode(data.response));
        } catch {
          return port.postMessage({ v: 1, id: data.id, op: data.op, error: { code: 'EINVAL', message: 'response is not a token response' } });
        }
        if (typeof token.access_token !== 'string') return port.postMessage({ v: 1, id: data.id, op: data.op, error: { code: 'EINVAL', message: 'response has no access_token' } });
        const expiresAt = Number.isFinite(token.expires_in) ? Date.now() + token.expires_in * 1000 : undefined;
        keep({ kind: 'model', name: data.name, value: token.access_token, provider: data.provider, source: 'oauth:' + data.provider, ...(expiresAt ? { expiresAt } : {}), ...(data.settings ? { settings: data.settings } : {}) });
        changed();
        announce();
        return reply({ records: live().filter((record) => record.kind === 'model' || record.kind === 'mcp').map((record) => ({ kind: record.kind, name: record.name, placeholder: record.placeholder, state: 'ready', ...(record.provider ? { provider: record.provider } : {}), ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) })), ...(expiresAt ? { expiresAt } : {}) });
      }
      if (data.op === 'model') return prepare(['model']);
      if (data.op === 'mcp') return prepare(['mcp']);
      if (data.op === 'redactStream') return reply({ stream: data.stream, idleMs: 250, version });
      if (data.op === 'push' && !(data.chunk instanceof Uint8Array)) return port.postMessage({ v: 1, id: data.id, op: data.op, error: { code: 'EINVAL', message: 'chunk must be bytes' } });
      if (data.op === 'push') {
        const text = new TextDecoder().decode(data.chunk);
        const hidden = hide(text);
        return reply({ chunk: hidden === text ? data.chunk : new TextEncoder().encode(hidden) });
      }
      if (data.op === 'idle') return reply({ chunk: new Uint8Array() });
      if (data.op === 'end') return reply({ chunk: new Uint8Array(), hits: [] });
      if (data.op === 'drop') return reply({});
      port.postMessage({ v: 1, id: data.id, error: { code: 'ENOTSUP', message: 'later' } });
    };
    agents.push(() => {
      while (!locked && held.length) answer(held.shift());
    });
    port.onmessage = (message) => {
      log({ role: 'agent', op: message.data.op });
      if (state.agentSilent) return;
      if (!state.agentReal) {
        port.postMessage({ v: 1, id: message.data.id, error: { code: 'ENOTSUP', message: 'later' } });
        return;
      }
      if (locked && !['records', 'endpoints'].includes(message.data.op)) held.push(message.data);
      else answer(message.data);
    };
  }
  port.postMessage({ v: 1, op: 'welcome', role, status: status() });
});
`;

const button = `
addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.type !== 'slicc-vault') return;
  fetch('/log', { method: 'POST', body: JSON.stringify({ role: 'button', op: event.data.op, theme: event.data.button?.theme ?? null }) });
  if (event.data.op === 'button') {
    document.documentElement.style.colorScheme = event.data.button.theme ?? 'normal';
    const control = document.querySelector('button');
    const config = event.data.button;
    control.textContent = config.label ?? (config.intent?.kind === 'protect' ? 'Vault lock' : 'Unlock vault');
    const { width, height } = control.getBoundingClientRect();
    parent.postMessage({ type: 'slicc-vault', v: 1, event: 'size', width: Math.ceil(width) + 4, height: Math.ceil(height) + 4, inset: 2 }, '*');
    parent.postMessage({ type: 'slicc-vault', v: 1, event: 'label', label: control.textContent }, '*');
  }
});
parent.postMessage({ type: 'slicc-vault', v: 1, event: 'ready' }, '*');
`;

const buttonPage =
  '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}button{margin:2px;height:32px;padding:0 14px;border-radius:16px;border:2px solid #8f8f8f;background:Canvas;color:CanvasText;font:700 14px system-ui;white-space:nowrap}</style><button type="button">Vault</button><script src="/button.js"></script>';

export async function startFakeVault(initial = {}) {
  const log = [];
  const state = { version: 0, locked: false, secrets: [], ...initial };
  const headers = {
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'no-store',
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    if (req.method === 'POST' && url.pathname === '/records') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const saved = JSON.parse(body);
        state.records = saved.records;
        state.version = saved.version;
        res.writeHead(204, headers);
        res.end();
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/log') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        log.push(JSON.parse(body));
        res.writeHead(204, headers);
        res.end();
      });
      return;
    }
    if (url.pathname === '/state') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          locked: state.locked,
          egress: state.egress ?? null,
          mute: state.mute === true,
          hold: state.hold ?? [],
        })
      );
    }
    const files = {
      '/': ['text/html', '<!doctype html><meta charset="utf-8"><script src="/frame.js"></script>'],
      '/frame.js': ['text/javascript', frame(state)],
      '/button.html': ['text/html', buttonPage],
      '/button.js': ['text/javascript', button],
    };
    const file = files[url.pathname];
    res.writeHead(file ? 200 : 404, { ...headers, 'content-type': file?.[0] ?? 'text/plain' });
    res.end(file?.[1] ?? 'missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://localhost:${server.address().port}`,
    unlock: () => {
      state.locked = false;
      state.unlocked = (state.unlocked ?? 0) + 1;
    },
    log,
    state,
    set: (next) => {
      if ('secrets' in next) delete state.records;
      return Object.assign(state, next);
    },
    close: () => server.close(),
  };
}
