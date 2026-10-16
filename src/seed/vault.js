export const PRODUCTION = 'https://seven.sliccy.ai';
export const VAULT = 'https://vault.sliccy.ai';
export const PREVIEW = 'https://vault-preview.sliccy.ai';
export const ORIGIN_KEY = 'slicc-os.vault-origin';
export const SCRUB_KEY = 'slicc-os.vault-scrub';
export const SUDO_KEY = 'slicc-os.vault-sudo-gid';
export const WELCOME_MS = 5000;
export const ANSWER_MS = 2000;
export const EGRESS_MS = 25000;
export const IMS_TOKEN = 'ADOBE_IMS_TOKEN';
export const FNOX_DIR = '/etc/fnox';
export const FNOX_CONFIG = 'default_provider = "seven"\n\n[providers.seven]\ntype = "sealed"\n';
export const NOT_CONNECTED = "seven's vault isn't connected";
export const RECONNECTED = "seven's vault reconnected before it answered";
const TYPE = 'slicc-vault';
const SCRUBBING = new Set(['put', 'seal', 'import']);

export function vaultOrigin({
  origin = globalThis.location?.origin,
  storage = globalThis.localStorage,
  report = (message) => console.error(message),
} = {}) {
  const wanted = storage?.getItem(ORIGIN_KEY) ?? null;
  if (origin === PRODUCTION) {
    if (wanted !== null) report(`vault: ${ORIGIN_KEY} is refused on ${PRODUCTION}; using ${VAULT}`);
    return VAULT;
  }
  if (wanted === null) return PREVIEW;
  const parsed = URL.parse(wanted);
  if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.origin !== wanted) {
    report(`vault: ${ORIGIN_KEY} must be an http(s) origin; using ${PREVIEW}`);
    return PREVIEW;
  }
  return parsed.origin;
}

export function takesVault(version) {
  return Number(/^(\d+)\./.exec(version ?? '')?.[1] ?? 0) >= 4;
}

export function hide(text, value) {
  const message = String(text ?? '');
  return typeof value === 'string' && value && message.includes(value)
    ? message.replaceAll(value, '[hidden]')
    : message;
}

export function failure(error, value) {
  const code = typeof error?.code === 'string' ? error.code : 'EIO';
  return Object.assign(new Error(hide(error?.message ?? 'the vault refused', value)), { code });
}

function pairOf(scrub) {
  if (typeof scrub?.needed !== 'boolean' || typeof scrub.version !== 'number') return null;
  return { needed: scrub.needed, version: scrub.version, ready: scrub.ready !== false };
}

function stored(storage) {
  try {
    return pairOf(JSON.parse(storage?.getItem(SCRUB_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function schemeOf(document, media) {
  const set = document?.documentElement?.style?.colorScheme;
  if (set === 'light' || set === 'dark') return set;
  return media?.matches ? 'dark' : 'light';
}

export function watchScheme(document, media, onChange) {
  let current = schemeOf(document, media);
  const check = () => {
    const next = schemeOf(document, media);
    if (next === current) return;
    current = next;
    onChange(next);
  };
  const Observer = globalThis.MutationObserver;
  const observer = Observer ? new Observer(check) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  media?.addEventListener?.('change', check);
  return () => {
    observer?.disconnect();
    media?.removeEventListener?.('change', check);
  };
}

export async function sudoGidOf(kernel) {
  if (!kernel?.users || kernel.users.mode === 'off' || !kernel.groups?.list) return undefined;
  const sudo = (await kernel.groups.list()).find((group) => group.name === 'sudo');
  return Number.isInteger(sudo?.gid) ? sudo.gid : undefined;
}

async function bytesOf(body, signal) {
  if (!body) return new Uint8Array(0);
  const chunks = [];
  for await (const chunk of body) {
    signal?.throwIfAborted();
    chunks.push(chunk);
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function pairs(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [String(name), String(value)]);
  if (typeof headers[Symbol.iterator] === 'function') return [...headers];
  return Object.entries(headers).map(([name, value]) => [name, String(value)]);
}

export function answerEgress(transport, request, port, { timers = globalThis } = {}) {
  let done = false;
  const body = new TextEncoder().encode(request.body ?? '');
  const controller = new AbortController();
  const reply = (message) => {
    if (done) return;
    done = true;
    timers.clearTimeout(deadline);
    body.fill(0);
    port.postMessage(message);
    port.close?.();
  };
  const deadline = timers.setTimeout(() => {
    reply({ error: 'ETIMEDOUT: the token request took too long' });
    controller.abort();
  }, EGRESS_MS);
  return (async () => {
    try {
      const response = await unfollowed(transport, {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
        signal: controller.signal,
      });
      body.fill(0);
      const status = response.status;
      const moved = response.redirected || response.type === 'opaqueredirect';
      if (moved || status === 0 || (status >= 300 && status < 400)) {
        response.cancel?.();
        return reply({ error: 'EACCES: the token endpoint redirected' });
      }
      const read = await bytesOf(response.body, controller.signal);
      reply({ status: response.status, headers: pairs(response.headers), body: read });
    } catch (error) {
      reply({ error: `${error?.code ?? 'EIO'}: the token request failed` });
    }
  })();
}

export function unfollowed(
  transport,
  request,
  { fetcher = (url, init) => globalThis.fetch(url, init) } = {}
) {
  if (transport?.traits?.manualRedirects)
    return transport.fetch({ ...request, redirect: 'manual' });
  return fetcher(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
  }).then((response) => ({
    status: response.status,
    type: response.type,
    redirected: response.redirected,
    headers: response.headers,
    body: response.body ? chunksOf(response.body) : null,
  }));
}

async function* chunksOf(stream) {
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) yield next.value;
}

export function vaultButtons({ document, origin, media }) {
  const buttons = new Set();
  let scheme = schemeOf(document, media);
  const stop = watchScheme(document, media, (next) => {
    scheme = next;
    for (const handle of buttons) handle.repaint();
  });
  function button() {
    const element = document.createElement('iframe');
    element.title = 'Vault';
    element.dataset.vault = 'button';
    element.style.border = '0';
    element.style.width = '0';
    element.style.height = '0';
    element.src = `${origin}/button.html`;
    const heard = new Set();
    let config = null;
    const send = (message) => element.contentWindow?.postMessage(message, origin);
    const onMessage = (event) => {
      if (event.source !== element.contentWindow || event.origin !== origin) return;
      const data = event.data;
      if (data?.type !== TYPE || data.v !== 1 || typeof data.event !== 'string') return;
      for (const listener of [...heard]) listener(data);
    };
    const handle = {
      repaint() {
        if (config) send({ type: TYPE, v: 1, op: 'button', button: { ...config, theme: scheme } });
      },
    };
    element.addEventListener('load', handle.repaint);
    buttons.add(handle);
    return {
      element,
      post(message) {
        if (message?.op !== 'button') return send(message);
        config = message.button;
        handle.repaint();
      },
      listen(listener) {
        if (!heard.size) globalThis.addEventListener('message', onMessage);
        heard.add(listener);
        return () => {
          heard.delete(listener);
          if (heard.size) return;
          globalThis.removeEventListener('message', onMessage);
          buttons.delete(handle);
        };
      },
    };
  }
  return { button, close: stop };
}

const data = (reply) => {
  const { v, id, op, ...rest } = reply;
  return rest;
};

const maybe = (key, value) => (value === undefined || value === null ? {} : { [key]: value });

export function vaultPort({ call, state, button }) {
  return {
    on: state.on,
    status: state.status,
    list: state.list,
    availability: state.availability,
    async audit(before, limit) {
      return data(await call('audit', { ...maybe('before', before), ...maybe('limit', limit) }));
    },
    async put(name, value, request, options = {}) {
      return data(
        await call('put', { ...options, name, value, ...maybe('request', request) }, { value })
      );
    },
    async cancel(request) {
      return (await call('cancel', { request })).state;
    },
    async remove(name, kind) {
      return data(await call('remove', { name, ...maybe('kind', kind) }));
    },
    async restore(name, kind) {
      return data(await call('restore', { name, ...maybe('kind', kind) }));
    },
    async import(kind, bytes, options = {}) {
      const fields = {
        kind,
        bytes,
        ...maybe('password', options.password),
        ...maybe('pick', options.pick),
      };
      return data(await call('import', fields, { value: options.password }));
    },
    async export(passphrase) {
      return (await call('export', { passphrase }, { value: passphrase })).bundle;
    },
    async lock() {
      await call('lock');
    },
    async dismissBackupReminder() {
      await call('dismissBackupReminder');
    },
    button,
  };
}

const CONSUME = ['ticket', 'stamp', 'path', 'resolved', 'argv', 'cwd', 'interpreters', 'trusted'];

const refusal = (code, message) => ({ v: 1, error: { code, message } });

export function sealedRelay({ call, forward, users, onRequest, away = () => false }) {
  return async (req, { signal } = {}) => {
    const { caller, ...rest } = req ?? {};
    if (away()) return refusal('ENOTCONN', NOT_CONNECTED);
    const exec = rest.op === 'materialize' || rest.op === 'materializeConsume';
    if (exec && users() !== 'enforce')
      return refusal('EACCES', 'secrets reach programs only when kernel users are enforce');
    try {
      if (rest.op === 'materializeConsume') {
        const fields = Object.fromEntries(
          CONSUME.filter((key) => key in rest).map((key) => [key, rest[key]])
        );
        const { values, placeholders } = await call('materializeConsume', fields, {
          signal,
          dropAway: true,
        });
        return { values, placeholders };
      }
      const { reply } = await call(
        'sealed',
        { req: rest, stamp: caller },
        { signal, value: rest.value, dropAway: true }
      );
      if (rest.op === 'seal') forward();
      if (rest.op === 'request' && reply?.state === 'pending' && typeof reply.id === 'string')
        onRequest(rest, reply.id, caller);
      return reply;
    } catch (error) {
      return refusal(error.code, error.message);
    }
  };
}

function snapshots({ now, timers, pending, view }) {
  const listeners = { status: new Set(), list: new Set(), availability: new Set() };
  let shown = 'connecting';
  const emit = (type, value) => {
    for (const listener of [...listeners[type]]) listener(value);
  };
  const availability = () => {
    if (!view.welcomed) return now() - view.since >= WELCOME_MS ? 'waiting' : 'connecting';
    const late = [...pending.values()].some((item) => item.sent && now() - item.at >= ANSWER_MS);
    if (late) return 'waiting';
    return view.status?.locked ? 'locked' : 'ready';
  };
  const refresh = () => {
    const next = availability();
    if (next === shown) return;
    shown = next;
    emit('availability', next);
  };
  return {
    emit,
    refresh,
    later: (ms) => timers.setTimeout(refresh, ms),
    on(type, listener) {
      if (!Object.hasOwn(listeners, type)) return () => undefined;
      listeners[type].add(listener);
      return () => listeners[type].delete(listener);
    },
    status: () => view.status,
    list: () => view.list,
    availability,
  };
}

const away = (view, state) => !view.welcomed && state.availability() === 'waiting';

function dropAway(pending, view, state) {
  if (!away(view, state)) return;
  for (const [id, item] of pending) {
    if (!item.dropAway || item.sent) continue;
    pending.delete(id);
    item.reject(failure({ code: 'ENOTCONN', message: NOT_CONNECTED }));
  }
}

const READS = new Set(['list', 'audit']);

function dropSent(pending) {
  for (const [id, item] of pending) {
    if (!item.sent) continue;
    if (READS.has(item.message.op)) {
      item.sent = null;
      continue;
    }
    pending.delete(id);
    item.reject(failure({ code: 'ENOTCONN', message: RECONNECTED }));
  }
}

function coreFrame(document) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.title = 'SLICC vault';
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.vault = 'core';
  return frame;
}

export function createVault({
  origin,
  document = globalThis.document,
  storage = globalThis.localStorage,
  timers = globalThis,
  now = Date.now,
  media = globalThis.matchMedia?.('(prefers-color-scheme: dark)') ?? null,
  sudoGid = async () => undefined,
  transport = null,
  users = () => 'off',
  onRequest = () => {},
  onCancelled = () => {},
  onRefresh = () => {},
}) {
  const pending = new Map();
  const workers = new Set();
  const view = { welcomed: false, since: now(), status: null, list: null };
  const state = snapshots({ now, timers, pending, view });
  const buttons = vaultButtons({ document, origin, media });
  const frame = coreFrame(document);
  let serial = 0;
  let page = null;
  let loads = 0;
  let scrub = stored(storage);
  let sentGid;

  const pair = () => (scrub ? { ...scrub } : null);
  const forward = () => {
    for (const worker of workers) worker.postMessage({ scrub: pair() }, []);
  };
  const take = (next) => {
    const taken = pairOf(next);
    if (!taken || JSON.stringify(taken) === JSON.stringify(scrub)) return;
    scrub = taken;
    storage?.setItem(SCRUB_KEY, JSON.stringify(taken));
    forward();
  };
  const post = (item) => {
    item.sent = page;
    item.at = now();
    page.postMessage(item.message, item.transfer);
    state.later(ANSWER_MS);
  };

  function call(op, fields = {}, { value, signal, transfer = [], dropAway = false } = {}) {
    if (signal?.aborted)
      return Promise.reject(failure({ code: 'ECANCELED', message: 'cancelled' }));
    const id = ++serial;
    const message = { ...fields, v: 1, id, op };
    return new Promise((resolve, reject) => {
      const item = { message, transfer, value, resolve, reject, sent: null, at: now(), dropAway };
      pending.set(id, item);
      signal?.addEventListener?.(
        'abort',
        () => {
          if (pending.delete(id)) reject(failure({ code: 'ECANCELED', message: 'cancelled' }));
          state.refresh();
        },
        { once: true }
      );
      if (view.welcomed) post(item);
    });
  }

  async function relist() {
    try {
      view.list = (await call('list')).list;
      state.emit('list', view.list);
    } catch {}
  }

  function answer(reply) {
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    if (reply.error) item.reject(failure(reply.error, item.value));
    else {
      if (SCRUBBING.has(item.message.op)) forward();
      item.resolve(reply);
    }
  }

  function event(message, ports) {
    if (message.event === 'status') {
      const relock = Boolean(view.status?.locked) !== Boolean(message.status?.locked);
      view.status = message.status;
      take(view.status?.scrub);
      if (relock)
        for (const worker of workers)
          worker.postMessage({ locked: Boolean(view.status?.locked) }, []);
      state.emit('status', view.status);
    } else if (message.event === 'placeholders') take(message.scrub);
    else if (message.event === 'changed') void relist();
    else if (message.event === 'egress' && ports[0] && transport)
      void answerEgress(transport, message.request, ports[0], { timers });
    else if (message.event === 'cancelled') onCancelled(message.request, message.kind);
    else if (message.event === 'refresh') onRefresh(message);
  }

  function receive(port, message, ports) {
    if (port !== page || message?.v !== 1) return;
    if (message.op === 'welcome') {
      view.welcomed = true;
      view.status = message.status;
      take(view.status?.scrub);
      state.emit('status', view.status);
      for (const item of pending.values()) post(item);
      void relist();
    } else if (message.op === 'refused') view.welcomed = false;
    else if (typeof message.id === 'number') answer(message);
    else if (typeof message.event === 'string') event(message, ports);
    state.refresh();
  }

  function agent(worker) {
    if (!loads || !frame.contentWindow) return;
    const { port1, port2 } = new MessageChannel();
    frame.contentWindow.postMessage({ type: TYPE, v: 1, op: 'hello', role: 'agent' }, origin, [
      port2,
    ]);
    worker.postMessage({ vault: port1, scrub: pair() }, [port1]);
  }

  async function hello() {
    const load = loads;
    const gid = await sudoGid().catch(() => undefined);
    if (load !== loads || !frame.contentWindow) return;
    sentGid = Number.isInteger(gid) ? gid : undefined;
    const { port1, port2 } = new MessageChannel();
    page?.close();
    dropSent(pending);
    page = port1;
    view.welcomed = false;
    view.since = now();
    port1.onmessage = ({ data: message, ports }) => receive(port1, message, ports ?? []);
    port1.start?.();
    const sudo = Number.isInteger(gid) ? { sudoGid: gid } : {};
    frame.contentWindow.postMessage(
      { type: TYPE, v: 1, op: 'hello', role: 'page', ...sudo },
      origin,
      [port2]
    );
    timers.setTimeout(() => dropAway(pending, view, state), WELCOME_MS);
    state.later(WELCOME_MS);
    state.refresh();
  }

  frame.addEventListener('load', () => {
    loads += 1;
    void hello();
    for (const worker of workers) agent(worker);
  });
  frame.src = `${origin}/`;
  document.body.append(frame);
  timers.setTimeout(() => dropAway(pending, view, state), WELCOME_MS);
  state.later(WELCOME_MS);

  return {
    origin,
    frame,
    port: vaultPort({ call, state, button: buttons.button }),
    call,
    sealed: sealedRelay({ call, forward, users, onRequest, away: () => away(view, state) }),
    scrub: pair,
    async seal(fields) {
      return data(await call('seal', fields, { value: fields.value }));
    },
    answer: (request, status, fields = {}) => call('answer', { ...fields, request, state: status }),
    async forward({ head, body, owner, exit, rawTraits }, port) {
      const fields = { head, owner, exit, rawTraits, ...maybe('body', body) };
      return data(await call('forward', fields, { transfer: [port] }));
    },
    attach(worker) {
      workers.add(worker);
      agent(worker);
      return () => workers.delete(worker);
    },
    reconnect: () => (loads ? hello() : Promise.resolve()),
    sudoGid(gid) {
      const wanted = Number.isInteger(gid) ? gid : undefined;
      return loads && wanted !== sentGid ? hello() : Promise.resolve();
    },
    close() {
      buttons.close();
      page?.close();
      frame.remove();
    },
  };
}

export function storedSudoGid(storage) {
  const text = storage?.getItem(SUDO_KEY) ?? null;
  const gid = Number(text);
  return text !== null && Number.isInteger(gid) ? gid : undefined;
}

export function keepSudoGid(storage, gid) {
  if (storedSudoGid(storage) === gid) return false;
  if (Number.isInteger(gid)) storage.setItem(SUDO_KEY, String(gid));
  else storage.removeItem(SUDO_KEY);
  return true;
}

export function takesSealed(version) {
  const [major, minor] = (/^(\d+)\.(\d+)\./.exec(version ?? '') ?? []).slice(1).map(Number);
  return major > 1 || (major === 1 && minor >= 68);
}

export function sealedOption(version, vault) {
  return takesSealed(version) ? { sealed: (req, context) => vault.sealed(req, context) } : {};
}

const FNOX_SEED = [
  'set -e',
  'mkdir -p "$1"',
  'chown 0:0 "$1"',
  'chmod 0755 "$1"',
  '[ -e "$1/config.toml" ] || printf "%s" "$2" > "$1/config.toml"',
  'chown 0:0 "$1/config.toml"',
  'chmod 0644 "$1/config.toml"',
].join('; ');

export async function seedFnox(kernel) {
  const { status, stderr } = await kernel.run(
    ['bash', '-c', FNOX_SEED, 'fnox', FNOX_DIR, FNOX_CONFIG],
    {
      cwd: '/',
    }
  );
  if (status) throw new Error(stderr.trim() || `the fnox config setup exited with ${status}`);
}
