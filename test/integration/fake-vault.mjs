import { createServer } from 'node:http';

const frame = (state) => `
const state = ${JSON.stringify(state)};
const log = (entry) => fetch('/log', { method: 'POST', body: JSON.stringify(entry) });
let version = state.version;
let locked = state.locked;
const secrets = state.secrets;
const pages = [];
const scrub = () => ({ needed: secrets.length > 0 || version > 0, version, ready: true });
const status = () => ({
  version: '1.9.0',
  protocol: 1,
  origin: location.ancestorOrigins?.[0] ?? '',
  locked,
  lock: locked ? 'passkey' : 'auto',
  scrub: scrub(),
  waiting: [],
  exportedAt: null,
  backupReminder: secrets.length ? 'due' : null,
  policy: [],
});
const view = (name) => ({
  name,
  kind: 'secret',
  placeholder: 'fnox_proxy_' + '0'.repeat(24),
  state: 'inert',
  source: 'settings',
  sourceDevice: null,
  domains: [],
  rules: [],
  exec: false,
  createdAt: 1767225600000,
});
const list = () => ({
  secrets: secrets.map(view),
  refused: [],
  audit: [],
  auditMore: false,
  exits: { file: '/etc/slicc/secrets-policy.toml', sha256: null, restricted: [] },
});
const page = (port) => (event) => {
  const { id, op } = event.data;
  log({ role: 'page', op, name: event.data.name, sealed: event.data.req?.op, stamp: Boolean(event.data.stamp) });
  const reply = (fields) => port.postMessage({ v: 1, id, op, ...fields });
  if (op === 'status') return reply({ status: status() });
  if (op === 'list') return reply({ list: list() });
  if (op === 'audit') return reply({ audit: [], more: false });
  if (op === 'sealed') return reply({ reply: { v: 1, secrets: secrets.map((name) => ({ name, placeholder: view(name).placeholder, state: 'inert', exec: false, rules: [] })) } });
  const refuse = () => port.postMessage({ v: 1, id, error: { code: 'EACCES', message: 'vault is locked: unlock it in the vault window' } });
  if (op === 'remove' || op === 'restore') {
    const at = secrets.indexOf(event.data.name);
    if (op === 'remove' && at >= 0) secrets.splice(at, 1);
    for (const each of pages) each.postMessage({ v: 1, event: 'changed', parts: ['secrets'] });
    return reply({ name: event.data.name, placeholder: view('X').placeholder, state: op === 'remove' ? 'removed' : 'inert' });
  }
  if ((op === 'import' || op === 'export') && locked) return refuse();
  if (op === 'dismissBackupReminder') return reply({ backupReminder: 'dismissed' });
  if (op === 'put' || op === 'seal') {
    if (locked) return refuse();
    if (!secrets.includes(event.data.name)) secrets.push(event.data.name);
    version += 1;
    for (const each of pages) {
      each.postMessage({ v: 1, event: 'placeholders', placeholders: [view('X').placeholder], scrub: scrub() });
      each.postMessage({ v: 1, event: 'status', status: status() });
      each.postMessage({ v: 1, event: 'changed', parts: ['secrets'] });
    }
    return reply({ name: event.data.name, placeholder: view('X').placeholder, state: 'inert' });
  }
  return port.postMessage({ v: 1, id, error: { code: 'ENOTSUP', message: op + ' arrives later' } });
};
setInterval(async () => {
  const wanted = (await (await fetch('/state')).json()).locked;
  if (wanted === locked) return;
  locked = wanted;
  for (const each of pages) each.postMessage({ v: 1, event: 'status', status: status() });
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
    port.onmessage = (message) => {
      log({ role: 'agent', op: message.data.op });
      if (state.agentSilent) return;
      port.postMessage({ v: 1, id: message.data.id, error: { code: 'ENOTSUP', message: 'later' } });
    };
  }
  port.postMessage({ v: 1, op: 'welcome', role, status: status() });
});
`;

const button = `
setInterval(async () => {
  const wanted = (await (await fetch('/state')).json()).locked;
  if (wanted === locked) return;
  locked = wanted;
  for (const each of pages) each.postMessage({ v: 1, event: 'status', status: status() });
}, 200);
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
      return res.end(JSON.stringify({ locked: state.locked }));
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
    set: (next) => Object.assign(state, next),
    close: () => server.close(),
  };
}
