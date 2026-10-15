import { createServer } from 'node:http';

const frame = (state) => `
const state = ${JSON.stringify(state)};
const log = (entry) => fetch('/log', { method: 'POST', body: JSON.stringify(entry) });
let version = state.version;
let locked = state.locked;
let serial = 0;
const records = new Map((state.records ?? []).map((record) => [record.kind + '\\u0000' + record.name, record]));
serial = records.size;
const save = () => fetch('/records', { method: 'POST', body: JSON.stringify({ records: [...records.values()], version }) });
const pages = [];
const agents = [];
const requests = new Map();
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
  version: '1.9.1',
  protocol: 1,
  origin: location.ancestorOrigins?.[0] ?? '',
  locked,
  lock: locked ? 'passkey' : 'auto',
  scrub: scrub(),
  waiting: [],
  exportedAt: null,
  backupReminder: live().some((record) => record.kind === 'secret') ? 'due' : null,
  policy: [],
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
  domains: [],
  rules: [],
  exec: false,
  createdAt: 1767225600000,
});
const list = () => ({
  secrets: live().map(view),
  refused: [],
  audit: [],
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
  const reply = (fields) => port.postMessage({ v: 1, id, op, ...fields });
  const refuse = () => port.postMessage({ v: 1, id, error: { code: 'EACCES', message: 'vault is locked: unlock it in the vault window' } });
  const result = (record) => ({ name: record.name, placeholder: record.placeholder, state: record.removedAt ? 'removed' : 'inert' });
  if (op === 'status') return reply({ status: status() });
  if (op === 'list') return reply({ list: list() });
  if (op === 'audit') return reply({ audit: [], more: false });
  if (op === 'placeholders') return reply({ placeholders: placeholders(), scrub: scrub() });
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
    const found = requests.get(event.data.request);
    log({ role: 'page', op: 'answered', request: event.data.request, state: event.data.state, exit: event.data.exit ?? null });
    if (!found || found.state !== 'pending') return port.postMessage({ v: 1, id, error: { code: 'EINVAL', message: 'the request ended' } });
    if (event.data.state === 'done') found.state = 'done';
    return reply({ state: found.state });
  }
  if (op === 'sealed') return reply({ reply: { v: 1, secrets: live().filter((record) => record.kind === 'secret').map((record) => ({ name: record.name, placeholder: record.placeholder, state: 'inert', exec: false, rules: [] })) } });
  if (op === 'remove' || op === 'restore') {
    const record = records.get(key(event.data.kind ?? 'secret', event.data.name));
    if (!record) return port.postMessage({ v: 1, id, error: { code: 'ENOENT', message: 'no record named ' + event.data.name } });
    if (op === 'remove') record.removedAt = Date.now();
    else delete record.removedAt;
    changed();
    reply(result(record));
    return announce();
  }
  if ((op === 'import' || op === 'export') && locked) return refuse();
  if (op === 'dismissBackupReminder') return reply({ backupReminder: 'dismissed' });
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
setInterval(async () => {
  const shared = await (await fetch('/state')).json();
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
      if (data.op === 'records') return reply({ records: live().filter((record) => record.kind === 'model' || record.kind === 'mcp').map((record) => ({ kind: record.kind, name: record.name, placeholder: record.placeholder, state: 'ready', ...(record.provider ? { provider: record.provider } : {}), ...(record.server ? { server: record.server } : {}) })) });
      if (data.op === 'endpoints') return reply({ ok: true });
      if (data.op === 'model') return prepare(['model']);
      if (data.op === 'mcp') return prepare(['mcp']);
      if (data.op === 'redactStream') return reply({ stream: data.stream, idleMs: 250, version });
      if (data.op === 'push') return reply({ chunk: data.chunk });
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
      return res.end(JSON.stringify({ locked: state.locked, egress: state.egress ?? null }));
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
