import {
  emitted as bounded,
  bytesOf,
  CONN_HEADER,
  claim,
  cut,
  evaluateExpression,
  FRAME,
  frameOf,
  GONE,
  json,
  LATE,
  LIFECYCLE,
  LOADER,
  NO_BROWSER,
  NO_HUB,
  NO_TARGET,
  nameOf,
  originOf,
  pageId,
  RECORDS,
  RELINK_MS,
  REPLY_BYTES,
  releaseExpression,
  SHAPES,
  STALE,
  sessionName,
  synthetic,
  TIMEOUT_MS,
  TOKEN_HEADER,
  TOO_BIG,
  targetId,
  targetInfo,
  translate,
  URL_CHARS,
  WEBHOOK,
} from './bridge-cdp.js';

const PROBE = '[location.href, document.title]';
const TITLE_CHARS = 200;

export const plain = (title) => claim(title, TITLE_CHARS);

export const UNKNOWN_PREVIEW = (token) => `seven holds no preview ${token}`;

const text = (value, key) => (typeof value?.[key] === 'string' ? value[key] : '');
const parse = (raw) => {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};
const event = (method, params, sessionId) => ({
  method,
  params,
  ...(sessionId ? { sessionId } : {}),
});
const answer = (id, outcome, sessionId) => ({
  id,
  ...(outcome.error ? { error: outcome.error } : { result: outcome.result }),
  ...(sessionId ? { sessionId } : {}),
});
const ok = (result = {}) => ({ result });
const refusal = (code, message) => ({ error: { code, message } });

function records(size = RECORDS) {
  let list = [];
  return {
    add(record) {
      list.push(record);
      if (list.length > size) list = list.slice(list.length - size);
    },
    of: (keep) => list.filter(keep),
    drop(gone) {
      const before = list.length;
      list = list.filter((record) => !gone(record));
      return before - list.length;
    },
  };
}

const BROWSER = {
  'Browser.getVersion': () =>
    ok({
      protocolVersion: '1.3',
      product: 'seven/preview-bridge',
      revision: '',
      userAgent: 'seven/preview-bridge',
      jsVersion: '',
    }),
  'Target.getTargets': (bridge, client) => ok({ targetInfos: bridge.infos(client) }),
  'Target.setDiscoverTargets': (bridge, client, params) => {
    const on = params.discover === true;
    const fresh = on && !client.discover;
    client.discover = on;
    if (fresh)
      for (const info of bridge.infos(client))
        client.deliver(event('Target.targetCreated', { targetInfo: info }));
    return ok();
  },
  'Target.setAutoAttach': (bridge, client, params) => {
    client.auto = params.autoAttach === true;
    if (client.auto)
      for (const conn of [...bridge.tabs.keys()])
        if (!attachedTo(client, conn)) bridge.attach(client, conn);
    return ok();
  },
  'Target.attachToTarget': (bridge, client, params) => {
    const conn = bridge.byTarget(text(params, 'targetId'));
    const id = conn === null ? null : bridge.attach(client, conn);
    return id ? ok({ sessionId: id }) : refusal(-32602, NO_TARGET);
  },
  'Target.detachFromTarget': (bridge, client, params) => {
    const id = text(params, 'sessionId');
    const item = client.sessions.get(id);
    if (!item) return refusal(-32602, 'No session with given id');
    client.sessions.delete(id);
    const target = targetId(bridge.tabs.get(item.conn), item.conn);
    client.deliver(event('Target.detachedFromTarget', { sessionId: id, targetId: target }));
    return ok();
  },
  'Target.closeTarget': (bridge, _client, params) => {
    const conn = bridge.byTarget(text(params, 'targetId'));
    if (conn === null) return refusal(-32602, NO_TARGET);
    bridge.send({ type: 'bridge.close', connId: conn });
    return ok({ success: true });
  },
  'Target.getTargetInfo': (bridge, client, params) => {
    const target = text(params, 'targetId');
    if (!target)
      return ok({
        targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true },
      });
    const conn = bridge.byTarget(target);
    if (conn === null) return refusal(-32602, NO_TARGET);
    return ok({ targetInfo: targetInfo(bridge.tabs.get(conn), conn, attachedTo(client, conn)) });
  },
  'Target.getBrowserContexts': () => ok({ browserContextIds: [] }),
  'Target.activateTarget': () => ok(),
  'Target.createTarget': () => refusal(-32000, NO_BROWSER),
  'Target.createBrowserContext': () => refusal(-32000, NO_BROWSER),
  'Browser.close': () => refusal(-32000, NO_BROWSER),
};

const attachedTo = (client, conn) =>
  [...client.sessions.values()].some((item) => item.conn === conn);
const groupKey = (conn, group) => `${conn}\n${group}`;

const SESSION = {
  'Runtime.enable': (bridge, client, sessionId, item) => {
    if (!item.runtime) {
      item.runtime = true;
      bridge.announce(client, sessionId);
    }
    return ok();
  },
  'Runtime.disable': (_bridge, _client, _sessionId, item) => {
    item.runtime = false;
    return ok();
  },
  'Runtime.releaseObject': (bridge, _client, sessionId, item, params) => {
    const page = pageId(bridge.tabs.get(item.conn)?.world, params.objectId);
    return bridge.release(item.conn, sessionId, page === null ? [] : [page]);
  },
  'Runtime.releaseObjectGroup': (bridge, _client, sessionId, item, params) => {
    const key = groupKey(item.conn, text(params, 'objectGroup'));
    const pages = bridge.groups.get(key);
    bridge.groups.delete(key);
    return bridge.release(item.conn, sessionId, pages);
  },
  'Target.closeTarget': (bridge, _client, _sessionId, item) => {
    bridge.send({ type: 'bridge.close', connId: item.conn });
    return ok({ success: true });
  },
};

export class Bridge {
  constructor({
    send = () => false,
    deliver = async () => undefined,
    timers = globalThis,
    now = () => new Date().toISOString(),
    clock = Date.now,
    session = () => sessionName(),
    warn = (message) => console.warn(message),
  } = {}) {
    Object.assign(this, { send, deliver, timers, now, clock, session, warn });
    this.previews = new Map();
    this.tabs = new Map();
    this.clients = new Set();
    this.pending = new Map();
    this.groups = new Map();
    this.bridged = new Map();
    this.log = records();
    this.contexts = 0;
    this.relays = 0;
    this.relink = null;
    this.control = {
      connected: (message) => this.connected(message),
      disconnected: (message) =>
        this.gone(text(message, 'connId'), text(message, 'reason') || undefined),
      responded: (message) => this.responded(message),
      emitted: (message) => this.emitted(message),
      relinked: () => this.relinked(),
      state: (message) => this.state(message),
    };
  }

  held() {
    return this.previews.size > 0;
  }

  forgetGroups(conn) {
    for (const key of [...this.groups.keys()])
      if (key.startsWith(groupKey(conn, ''))) this.groups.delete(key);
  }

  tell(preview, record) {
    this.log.add(record);
    for (const listener of [...(preview?.listeners ?? [])]) listener(record);
  }

  handOn(name, delivery) {
    return Promise.resolve()
      .then(() => this.deliver(name, delivery))
      .then((answer) => {
        if (answer?.delivered === false)
          this.warn(`serve: the agent has no webhook ${name}, so it dropped the delivery`);
      })
      .catch((error) => this.warn(`serve: the webhook ${name}: ${error.message}`));
  }

  sessionsOf(conn) {
    return [...this.clients].flatMap((client) =>
      [...client.sessions]
        .filter(([, item]) => item.conn === conn)
        .map(([id, item]) => ({ client, id, item }))
    );
  }

  byTarget(target) {
    return [...this.tabs].find(([conn, tab]) => targetId(tab, conn) === target)?.[0] ?? null;
  }

  infos(client) {
    return [...this.tabs].map(([conn, tab]) => targetInfo(tab, conn, attachedTo(client, conn)));
  }

  attach(client, conn) {
    const tab = this.tabs.get(conn);
    if (!tab) return null;
    const id = this.session();
    client.sessions.set(id, { conn, runtime: false });
    client.deliver(
      event('Target.attachedToTarget', {
        sessionId: id,
        targetInfo: targetInfo(tab, conn, true),
        waitingForDebugger: false,
      })
    );
    return id;
  }

  fail(relay, message) {
    const call = this.pending.get(relay);
    if (!call) return;
    this.pending.delete(relay);
    this.timers.clearTimeout(call.timer);
    call.client?.deliver(answer(call.id, refusal(-32000, message), call.session));
  }

  dropTab(conn) {
    const tab = this.tabs.get(conn);
    if (!tab) return null;
    this.tabs.delete(conn);
    this.forgetGroups(conn);
    const target = targetId(tab, conn);
    for (const client of this.clients) {
      for (const [id, item] of [...client.sessions]) {
        if (item.conn !== conn) continue;
        client.sessions.delete(id);
        client.deliver(event('Target.detachedFromTarget', { sessionId: id, targetId: target }));
      }
      if (client.discover) client.deliver(event('Target.targetDestroyed', { targetId: target }));
    }
    for (const [relay, call] of [...this.pending]) if (call.conn === conn) this.fail(relay, GONE);
    return tab;
  }

  announce(client, id) {
    const tab = this.tabs.get(client.sessions.get(id)?.conn);
    if (!tab) return;
    const context = {
      id: tab.world,
      origin: tab.origin,
      name: '',
      uniqueId: `preview-${tab.world}`,
      auxData: { isDefault: true, type: 'default', frameId: FRAME },
    };
    client.deliver(event('Runtime.executionContextCreated', { context }, id));
  }

  navigated(conn, url) {
    const tab = this.tabs.get(conn);
    if (!tab) return;
    if (url) tab.url = url;
    this.forgetGroups(conn);
    this.contexts += 1;
    tab.world = this.contexts;
    const listening = this.sessionsOf(conn);
    for (const { client, id } of listening)
      client.deliver(event('Page.frameNavigated', { frame: frameOf(tab), type: 'Navigation' }, id));
    for (const { client, id, item } of listening) {
      if (!item.runtime) continue;
      client.deliver(event('Runtime.executionContextsCleared', {}, id));
      this.announce(client, id);
    }
    for (const { client, id } of listening)
      client.deliver(event('Page.loadEventFired', { timestamp: this.clock() / 1000 }, id));
  }

  settled(call, message) {
    if (message.error && typeof message.error === 'object')
      return refusal(
        Number.isInteger(message.error.code) ? message.error.code : -32603,
        text(message.error, 'message')
      );
    const reply = message.result && typeof message.result === 'object' ? message.result : {};
    const size = json(reply);
    if (size === null || bytesOf(size) > REPLY_BYTES) return refusal(-32000, TOO_BIG);
    const outcome = SHAPES[call.shape](call.world, reply);
    const page = pageId(
      call.world,
      outcome.result?.result?.objectId ?? outcome.result?.object?.objectId
    );
    if (call.group && page !== null) {
      const key = groupKey(call.conn, call.group);
      this.groups.set(key, [...(this.groups.get(key) ?? []), page]);
    }
    return outcome;
  }

  responded(message) {
    const relay = message?.id;
    const call = this.pending.get(relay);
    if (!call || text(message, 'connId') !== call.conn) return;
    this.pending.delete(relay);
    this.timers.clearTimeout(call.timer);
    const outcome = this.settled(call, message);
    call.done?.(outcome);
    if (!call.client) return;
    const moved = call.method === 'Page.navigate' && !outcome.error;
    call.client.deliver(
      answer(call.id, moved ? ok({ frameId: FRAME, loaderId: LOADER }) : outcome, call.session)
    );
    if (moved) this.navigated(call.conn, call.url);
  }

  forward(conn, sessionId, method, params, call) {
    this.relays += 1;
    const relay = this.relays;
    const request = { type: 'bridge.cdp.request', connId: conn, id: relay, method, params };
    if (!this.send({ ...request, sessionId })) return false;
    this.pending.set(relay, {
      session: sessionId,
      conn,
      method,
      ...call,
      timer: this.timers.setTimeout(() => this.fail(relay, LATE), TIMEOUT_MS),
    });
    return true;
  }

  probe(conn) {
    const params = { expression: evaluateExpression(PROBE, true), returnByValue: true };
    const done = (outcome) => {
      const [url, title] = outcome.result?.result?.value ?? [];
      const tab = this.tabs.get(conn);
      if (!tab || typeof url !== 'string' || url.length > URL_CHARS) return;
      if (URL.parse(url)?.origin !== tab.origin) return;
      tab.url = url;
      if (typeof title === 'string') tab.title = plain(title);
      for (const client of this.clients) {
        const info = targetInfo(tab, conn, attachedTo(client, conn));
        if (client.discover)
          client.deliver(event('Target.targetInfoChanged', { targetInfo: info }));
      }
    };
    this.forward(conn, undefined, 'Runtime.evaluate', params, {
      client: null,
      shape: 'remote',
      world: this.tabs.get(conn)?.world,
      done,
    });
  }

  release(conn, sessionId, pages) {
    if (pages?.length) {
      const params = { expression: releaseExpression(pages) };
      this.forward(conn, sessionId, 'Runtime.evaluate', params, { client: null, shape: 'raw' });
    }
    return ok();
  }

  relayed(client, id, sessionId, conn, method, params) {
    const world = this.tabs.get(conn)?.world;
    const made = translate(world, method, params);
    if (made.error) return made;
    const call = {
      client,
      world,
      id,
      shape: made.shape,
      group: typeof params.objectGroup === 'string' ? params.objectGroup : null,
      url: typeof params.url === 'string' ? params.url : null,
    };
    const sent = this.forward(conn, sessionId, made.method, made.params, call);
    return sent ? null : refusal(-32000, NO_HUB);
  }

  inSession(client, id, sessionId, method, params) {
    const item = client.sessions.get(sessionId);
    if (!item) return refusal(-32001, `Session with given id not found: ${sessionId}`);
    const tab = this.tabs.get(item.conn);
    if (!tab) return refusal(-32000, GONE);
    const own = SESSION[method];
    if (own) return own(this, client, sessionId, item, params);
    return (
      synthetic(method, tab, item.conn) ??
      this.relayed(client, id, sessionId, item.conn, method, params)
    );
  }

  command(client, raw) {
    const message = parse(raw);
    const method = text(message, 'method');
    const { id } = message;
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const outcome = sessionId
      ? this.inSession(client, id, sessionId, method, params)
      : (BROWSER[method]?.(this, client, params) ?? refusal(-32601, `'${method}' wasn't found`));
    if (outcome) client.deliver(answer(id, outcome, sessionId));
  }

  connection() {
    let closed = false;
    const client = {
      discover: false,
      auto: false,
      sessions: new Map(),
      deliver: (message) => {
        if (!closed) wire.onmessage?.(JSON.stringify(message));
      },
    };
    this.clients.add(client);
    const wire = {
      onmessage: null,
      onclose: null,
      send: (raw) => {
        if (!closed) this.command(client, raw);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.clients.delete(client);
        for (const [relay, call] of [...this.pending])
          if (call.client === client) {
            this.pending.delete(relay);
            this.timers.clearTimeout(call.timer);
          }
      },
    };
    return wire;
  }

  record(type, token, conn, fields) {
    const at = this.now();
    return { at, event: type, previewToken: token, connId: conn, announced: false, ...fields };
  }

  opened(token, conn, message, preview) {
    this.contexts += 1;
    const tab = {
      world: this.contexts,
      stale: false,
      token,
      origin: originOf(preview.url),
      from: originOf(message.origin),
      userAgent: claim(message.userAgent),
      url: preview.url,
      title: preview.title,
    };
    this.tabs.set(conn, tab);
    for (const client of this.clients) {
      if (client.discover)
        client.deliver(event('Target.targetCreated', { targetInfo: targetInfo(tab, conn, false) }));
      if (client.auto) this.attach(client, conn);
    }
    return tab;
  }

  connected(message) {
    const token = text(message, 'previewToken');
    const conn = text(message, 'connId');
    const known = this.tabs.get(conn);
    if (known?.token === token) known.stale = false;
    const preview = this.previews.get(token);
    if (!conn || known || !preview) return;
    const replay = message.replay === true;
    const first = !preview.announced && !replay;
    if (first || replay) preview.announced = true;
    const tab = this.opened(token, conn, message, preview);
    this.probe(conn);
    if (replay) return;
    if (first) this.send({ type: 'preview.state.update', previewToken: token, announced: true });
    const fields = {
      origin: tab.from,
      userAgent: tab.userAgent,
      connectedAt: claim(message.connectedAt, 64),
    };
    const announced = first && !preview.quiet;
    this.tell(preview, this.record('connected', token, conn, { ...fields, announced }));
    if (!announced) return;
    const headers = {
      'content-type': 'application/json',
      [LIFECYCLE]: 'connected',
      [CONN_HEADER]: conn,
      [TOKEN_HEADER]: token,
    };
    void this.handOn(preview.webhook, { id: null, headers, body: JSON.stringify(fields) });
  }

  gone(conn, reason) {
    const tab = this.dropTab(conn);
    if (!tab) return;
    const fields = { origin: tab.from, userAgent: tab.userAgent, ...(reason ? { reason } : {}) };
    this.tell(this.previews.get(tab.token), this.record('disconnected', tab.token, conn, fields));
  }

  emitted(message) {
    if (!WEBHOOK.test(text(message, 'webhookId'))) return false;
    const headers = message.headers && typeof message.headers === 'object' ? message.headers : {};
    const token = text(headers, TOKEN_HEADER);
    const conn = text(headers, CONN_HEADER);
    const tab = this.tabs.get(conn);
    const live = tab?.token === token;
    const preview = live ? this.previews.get(tab.token) : undefined;
    if (!preview) {
      this.warn(
        `serve: dropped an emit for ${message.webhookId} from a connection seven doesn't hold`
      );
      return true;
    }
    if (preview.webhook !== message.webhookId) return true;
    const body = message.body && typeof message.body === 'object' ? message.body : {};
    const name = nameOf(body.name);
    const payload = { name, ...bounded(body.detail) };
    this.tell(preview, this.record('emit', token, conn, { name, detail: cut(body.detail) }));
    void this.handOn(preview.webhook, {
      id: null,
      headers: { 'content-type': 'application/json', [CONN_HEADER]: conn, [TOKEN_HEADER]: token },
      body: JSON.stringify(payload),
    });
    return true;
  }

  relinked() {
    for (const tab of this.tabs.values()) tab.stale = true;
    this.timers.clearTimeout(this.relink);
    this.relink = this.timers.setTimeout(() => {
      this.relink = null;
      for (const [conn, tab] of [...this.tabs]) if (tab.stale) this.gone(conn, STALE);
    }, RELINK_MS);
  }

  state(message) {
    const preview = this.previews.get(text(message, 'previewToken'));
    if (!preview) return;
    if (typeof message.quiet === 'boolean') preview.quiet = message.quiet;
    if (typeof message.announced === 'boolean') preview.announced = message.announced;
  }

  add({ token, url, title = '', quiet = false, webhook, uid = null }) {
    const preview = { url, title, quiet, announced: false, webhook, uid, listeners: new Set() };
    this.previews.set(token, preview);
    this.bridged.set(token, uid);
    return {
      on(listener) {
        preview.listeners.add(listener);
        return () => preview.listeners.delete(listener);
      },
      remove: () => {
        if (this.previews.get(token) !== preview) return;
        this.previews.delete(token);
        for (const [conn, tab] of [...this.tabs]) if (tab.token === token) this.dropTab(conn);
      },
    };
  }

  tokens(token, uid) {
    const seen = (owner) => uid === 0 || owner === uid;
    if (token === null || token === undefined)
      return [...this.bridged].filter(([, owner]) => seen(owner)).map(([key]) => key);
    if (!this.bridged.has(token) || !seen(this.bridged.get(token)))
      throw new DOMException(UNKNOWN_PREVIEW(token), 'NotFoundError');
    return [token];
  }

  logs(token, uid = 0) {
    const tokens = new Set(this.tokens(token, uid));
    return this.log.of((item) => tokens.has(item.previewToken));
  }

  truncate(token, uid = 0) {
    const tokens = this.tokens(token, uid);
    const cleared = this.log.drop((item) => tokens.includes(item.previewToken));
    const held = tokens.filter((key) => this.previews.has(key));
    for (const key of held) {
      this.previews.get(key).announced = false;
      this.send({ type: 'preview.state.update', previewToken: key, announced: false });
    }
    return { cleared, rearmed: held.length };
  }
}

export function joined(primary, secondary) {
  const mine = new Set();
  const fanned = new Map();
  const FAN = new Set(['Target.getTargets', 'Target.setDiscoverTargets', 'Target.setAutoAttach']);
  const wire = { onmessage: null, onclose: null, send, close };
  const forward = (message) => wire.onmessage?.(JSON.stringify(message));

  function settle(id, side, message) {
    const fan = fanned.get(id);
    fan[side] = message;
    if (!fan.primary || !fan.secondary) return;
    fanned.delete(id);
    const { primary: first, secondary: second } = fan;
    if (fan.method !== 'Target.getTargets' || first.error) return forward(first);
    const more = second.error ? [] : (second.result?.targetInfos ?? []);
    forward({
      ...first,
      result: { ...first.result, targetInfos: [...(first.result?.targetInfos ?? []), ...more] },
    });
  }

  const from = (side) => (raw) => {
    const message = parse(raw);
    if (message.id !== undefined && message.sessionId === undefined && fanned.has(message.id))
      return settle(message.id, side, message);
    if (side === 'secondary' && message.method === 'Target.attachedToTarget')
      mine.add(message.params?.sessionId);
    if (side === 'secondary' && message.method === 'Target.detachedFromTarget')
      mine.delete(message.params?.sessionId);
    wire.onmessage?.(raw);
  };

  function send(raw) {
    const message = parse(raw);
    const target = message.params?.targetId;
    if (message.sessionId !== undefined)
      return (mine.has(message.sessionId) ? secondary : primary).send(raw);
    if (typeof target === 'string' && target.startsWith('preview:')) return secondary.send(raw);
    if (message.method === 'Target.detachFromTarget' && mine.has(message.params?.sessionId))
      return secondary.send(raw);
    if (FAN.has(message.method) && message.id !== undefined && !fanned.has(message.id)) {
      fanned.set(message.id, { method: message.method });
      primary.send(raw);
      return secondary.send(raw);
    }
    return primary.send(raw);
  }

  function close() {
    primary.close();
    secondary.close();
  }

  primary.onmessage = from('primary');
  secondary.onmessage = from('secondary');
  primary.onclose = (why) => {
    secondary.close();
    wire.onclose?.(why);
  };
  return wire;
}
