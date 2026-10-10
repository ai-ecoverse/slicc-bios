import { browserHosts } from './cdp.js';

export const HOLD = 10000;
export const FRESH = 2000;
export const SHOT_GAP = 1000;
export const SHOT_WIDTH = 960;
export const CALL_TIMEOUT = 10000;
export const KEEP = 50;
export const STOPPED_WITHIN = 2000;
const KEY = 'slicc-os.browser.tabs';
const KINDS = new Set([
  'open',
  'goto',
  'back',
  'reload',
  'close',
  'select',
  'snapshot',
  'screenshot',
  'eval',
  'click',
  'fill',
  'type',
  'press',
  'scroll',
  'request',
]);
const LABELLED = new Set(['click', 'fill', 'type', 'press', 'screenshot', 'select', 'scroll']);
const CAP = 200;
const HIERARCHICAL = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
  'ftp:',
  'file:',
  'chrome:',
  'chrome-extension:',
]);
const OPAQUE = new Set(['data:', 'javascript:', 'blob:', 'about:', 'view-source:']);
export const ERRORS = new Set([
  'element not found',
  'no snapshot',
  'unknown tab',
  'navigation failed',
  'timeout',
  'connection lost',
  'not allowed',
  'failed',
]);
const OPENABLE = /^(https?:\/\/|about:blank$)/i;

function parse(text) {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

function openable(url) {
  if (typeof url !== 'string' || !OPENABLE.test(url)) {
    throw new Error(`only http, https and about:blank can be opened here: ${url}`);
  }
  return url;
}

function text(value, cap = CAP) {
  if (typeof value !== 'string') return undefined;
  const line = value
    .split('\n')
    .find((part) => part.trim())
    ?.trim();
  return line ? line.slice(0, cap) : undefined;
}

function address(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.href.toLowerCase() === 'about:blank') return 'about:blank';
  if (OPAQUE.has(url.protocol)) return url.protocol;
  if (!HIERARCHICAL.has(url.protocol)) return undefined;
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return text(url.href);
}

function valueOf(kind, params) {
  if (kind === 'open' || kind === 'goto') return address(params.url);
  if (kind === 'press') {
    return typeof params.key === 'string' && /^[\w+-]{1,32}$/.test(params.key)
      ? params.key
      : undefined;
  }
  if (kind === 'request') {
    const method = /^[A-Z]{1,10}$/.test(params.method ?? '') ? params.method : 'GET';
    const url = address(params.url);
    return url && `${method} ${url}`;
  }
  return undefined;
}

export function agentOf(value) {
  if (typeof value !== 'string') return null;
  if (/^cone:[\w.-]{1,64}$/.test(value)) return value.slice('cone:'.length);
  if (/^scoop:[\w.-]{1,64}$/.test(value)) return value;
  return null;
}

export function sanitize(params) {
  const kind = KINDS.has(params?.kind) ? params.kind : null;
  if (!kind) return null;
  const action = { kind };
  const target = LABELLED.has(kind) ? text(params.target) : undefined;
  if (target) action.target = target;
  const value = valueOf(kind, params);
  if (value) action.value = value;
  if ((kind === 'fill' || kind === 'type') && Number.isSafeInteger(params.length)) {
    action.length = Math.max(0, params.length);
  }
  return action;
}

export function pageClient(opener, clock) {
  const pending = new Map();
  const listeners = new Set();
  let opening;
  let next = 0;

  const drop = (why) => {
    opening = undefined;
    for (const [, call] of pending) call.reject(new Error(why ?? 'the browser connection closed'));
    pending.clear();
  };

  const receive = (text) => {
    const message = parse(text);
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message ?? 'CDP error'));
      else call.resolve(message.result ?? {});
    } else if (message.method) {
      for (const listener of [...listeners]) listener(message);
    }
  };

  const ensure = () => {
    opening ??= Promise.resolve()
      .then(opener)
      .then(
        (connection) => {
          connection.onmessage = receive;
          connection.onclose = drop;
          return connection;
        },
        (error) => {
          opening = undefined;
          throw error;
        }
      );
    return opening;
  };

  return {
    async call(method, params = {}, sessionId) {
      const connection = await ensure();
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = clock.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, CALL_TIMEOUT);
        const done = (settle) => (value) => {
          clock.clearTimeout(timer);
          settle(value);
        };
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        connection.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function restore(storage) {
  try {
    const stored = JSON.parse(storage?.getItem(KEY) ?? '{}');
    return new Map(
      Object.entries(stored && typeof stored === 'object' ? stored : {}).map(([id, agentId]) => [
        id,
        typeof agentId === 'string' ? agentId : null,
      ])
    );
  } catch {
    return new Map();
  }
}

function defaultOpener(network) {
  return () => {
    const hosts = browserHosts(network);
    const open = hosts.extension || hosts.proxy;
    if (!open) throw new Error('no browser to drive');
    return open();
  };
}

class Browser {
  #clock;
  #now;
  #storage;
  #client;
  #listeners = new Map();
  #owned;
  #infos = new Map();
  #opening = new Map();
  #frames = new Map();
  #use = new Map();
  #queue = new Set();
  #refreshed = -Infinity;
  #refreshing;
  #provisional = 0;
  #capturing = false;
  #activated = null;
  #actions = [];
  #counter = 0;
  #connections = new Set();
  #stops = new Map();

  constructor(network, options) {
    this.#clock = options.clock ?? globalThis;
    this.#now = options.now ?? (() => Date.now());
    this.#storage = options.storage === undefined ? globalThis.sessionStorage : options.storage;
    this.#client = pageClient(options.opener ?? defaultOpener(network), this.#clock);
    this.#owned = restore(this.#storage);
  }

  on(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    const set = this.#listeners.get(type);
    set.add(listener);
    return () => set.delete(listener);
  }

  #emit(type, detail) {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(detail);
  }

  #save() {
    try {
      this.#storage?.setItem(KEY, JSON.stringify(Object.fromEntries(this.#owned)));
    } catch {}
  }

  #controlled(id) {
    const state = this.#use.get(id);
    return Boolean(state && (state.sessions > 0 || state.timer));
  }

  #tab(id) {
    const info = this.#infos.get(id);
    return {
      id,
      title: info.title ?? '',
      url: info.url ?? '',
      status: this.#loading(id) ? 'loading' : 'complete',
      agentId: this.#owned.get(id) ?? null,
      controlled: this.#controlled(id),
    };
  }

  #loading(id) {
    return this.#actions.some(
      (action) =>
        action.tabId === id &&
        action.status === 'running' &&
        (action.kind === 'open' || action.kind === 'goto')
    );
  }

  actions(tabId) {
    const all = tabId ? this.#actions.filter((action) => action.tabId === tabId) : this.#actions;
    return all.map((action) => ({ ...action }));
  }

  #record(action) {
    if (!this.#actions.includes(action)) this.#actions.push(action);
    while (this.#actions.length > KEEP) this.#actions.shift();
    this.#emit('action', { ...action });
  }

  begin(link, params) {
    const sanitized = sanitize(params);
    if (!sanitized) return;
    const agentId = agentOf(params.agent);
    if (agentId) link.agent = agentId;
    const action = {
      id: `a${++this.#counter}`,
      tabId: link.tab(params.tab),
      agentId: link.agent ?? null,
      ...sanitized,
      status: 'running',
      at: this.#now(),
    };
    link.action = action;
    if (action.tabId) this.own(action.tabId, action.agentId);
    this.#record(action);
    if (action.tabId) this.changed();
  }

  finish(link, params) {
    const action = link.action;
    if (action?.status !== 'running') return;
    action.tabId ??= link.tab(params.tab);
    if (action.tabId) this.own(action.tabId, action.agentId);
    action.status = params.ok === false ? 'failed' : 'done';
    const error = action.kind === 'eval' ? undefined : ERRORS.has(params.error) && params.error;
    if (action.status === 'failed' && error) action.error = error;
    this.#record(action);
    if (action.tabId) this.changed();
  }

  interrupted(link) {
    const action = link.action;
    if (action?.status !== 'running') return;
    const at = this.#stops.get(action.agentId);
    action.status = 'failed';
    action.error =
      at !== undefined && this.#now() - at <= STOPPED_WITHIN ? 'Stopped' : 'Interrupted';
    this.#record(action);
    if (action.tabId) this.changed();
  }

  owns(id) {
    return this.#owned.has(id);
  }

  placed(link, target) {
    link.action.tabId = target;
    this.own(target, link.action.agentId);
    this.#record(link.action);
    this.changed();
  }

  link(link) {
    this.#connections.add(link);
    return () => this.#connections.delete(link);
  }

  stopped(agentId) {
    if (!agentId) return;
    this.#stops.set(agentId, this.#now());
    for (const link of [...this.#connections]) if (link.agent === agentId) link.kill('Stopped');
    for (const [id, entry] of this.#use) {
      if (this.#owned.get(id) === agentId && entry.sessions === 0) {
        this.#release(id);
      }
    }
    this.changed();
  }

  list() {
    if (this.#now() - this.#refreshed > FRESH) void this.refresh();
    const known = [...this.#owned.keys()].filter((id) => this.#infos.has(id));
    return [...known.map((id) => this.#tab(id)), ...this.#opening.values()];
  }

  active() {
    const reported = [...this.#owned.keys()].find((id) => this.#infos.get(id)?.active);
    if (reported) return reported;
    return this.#owned.has(this.#activated) && this.#infos.has(this.#activated)
      ? this.#activated
      : null;
  }

  changed() {
    this.#emit('tabs', this.list());
    this.#emit('active', this.active());
  }

  forget(id) {
    if (!this.#owned.delete(id)) return;
    this.#infos.delete(id);
    this.#frames.delete(id);
    this.#queue.delete(id);
    this.#release(id);
    this.#use.delete(id);
    this.#save();
  }

  refresh() {
    if (this.#owned.size === 0) {
      this.#refreshed = this.#now();
      return Promise.resolve();
    }
    this.#refreshing ??= this.#client
      .call('Target.getTargets')
      .then(
        ({ targetInfos = [] }) => {
          this.#infos.clear();
          for (const info of targetInfos)
            if (this.#owned.has(info.targetId)) this.#infos.set(info.targetId, info);
          for (const id of [...this.#owned.keys()]) if (!this.#infos.has(id)) this.forget(id);
        },
        () => this.#infos.clear()
      )
      .finally(() => {
        this.#refreshed = this.#now();
        this.#refreshing = undefined;
        this.changed();
      });
    return this.#refreshing;
  }

  own(id, agentId = null) {
    if (typeof id !== 'string' || !id) return;
    const known = this.#owned.has(id);
    this.#owned.set(id, agentId ?? this.#owned.get(id) ?? null);
    this.#save();
    if (!known) void this.refresh();
  }

  state(id) {
    if (!this.#use.has(id)) {
      this.#use.set(id, { sessions: 0, timer: undefined, hold: undefined, shot: 0 });
    }
    return this.#use.get(id);
  }

  #attach(id) {
    return this.#client
      .call('Target.attachToTarget', { targetId: id, flatten: true })
      .then(({ sessionId }) => sessionId);
  }

  #detach(sessionId) {
    return this.#client.call('Target.detachFromTarget', { sessionId }).then(
      () => undefined,
      () => undefined
    );
  }

  #release(id) {
    const entry = this.#use.get(id);
    if (!entry) return;
    this.#clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    const hold = entry.hold;
    entry.hold = undefined;
    if (hold) void hold.then((sessionId) => sessionId && this.#detach(sessionId));
  }

  touch(id, sessions = 0) {
    const entry = this.state(id);
    const was = this.#controlled(id);
    entry.sessions += sessions;
    this.#clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.hold ??= this.#attach(id).catch(() => undefined);
    if (!was) this.changed();
  }

  linger(id) {
    const entry = this.state(id);
    if (entry.sessions > 0) return;
    this.#clock.clearTimeout(entry.timer);
    entry.timer = this.#clock.setTimeout(() => {
      entry.timer = undefined;
      if (entry.sessions > 0) return;
      this.#release(id);
      this.changed();
    }, HOLD);
  }

  async #session(id, work) {
    const entry = this.state(id);
    const held = entry.hold ? await entry.hold : undefined;
    const sessionId = held ?? (await this.#attach(id));
    try {
      return await work(sessionId);
    } finally {
      if (!held) await this.#detach(sessionId);
    }
  }

  #capture(id) {
    return this.#session(id, async (sessionId) => {
      const metrics = await this.#client.call('Page.getLayoutMetrics', {}, sessionId);
      const view = metrics.cssVisualViewport ?? metrics.layoutViewport ?? {};
      const width = view.clientWidth ?? SHOT_WIDTH;
      const height = view.clientHeight ?? Math.round((SHOT_WIDTH * 10) / 16);
      const clip = {
        x: view.pageX ?? 0,
        y: view.pageY ?? 0,
        width,
        height,
        scale: Math.min(1, SHOT_WIDTH / width),
      };
      const { data } = await this.#client.call(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 70, clip },
        sessionId
      );
      const frame = { tabId: id, src: `data:image/jpeg;base64,${data}`, at: this.#now() };
      if (this.#owned.has(id)) {
        this.#frames.set(id, frame);
        this.#emit('frame', frame);
      }
      return frame.src;
    });
  }

  async #drain() {
    if (this.#capturing) return;
    this.#capturing = true;
    try {
      while (this.#queue.size > 0) {
        const id = [...this.#queue].at(-1);
        this.#queue.delete(id);
        if (!this.#owned.has(id)) continue;
        const entry = this.state(id);
        const wait = entry.shot + SHOT_GAP - this.#now();
        if (wait > 0) await new Promise((resolve) => this.#clock.setTimeout(resolve, wait));
        entry.shot = this.#now();
        await this.#capture(id).catch(() => undefined);
      }
    } finally {
      this.#capturing = false;
    }
  }

  settled(id) {
    this.#queue.delete(id);
    this.#queue.add(id);
    void this.#drain();
  }

  activate(id) {
    if (!this.#owned.has(id)) return;
    void this.#client.call('Target.activateTarget', { targetId: id }).then(
      () => {
        this.#activated = id;
        this.#emit('active', this.active());
      },
      () => undefined
    );
  }

  open(url, agentId = null) {
    openable(url);
    const id = `opening-${++this.#provisional}`;
    const placeholder = { id, title: url, url, status: 'loading', agentId, controlled: false };
    this.#opening.set(id, placeholder);
    void this.#client
      .call('Target.createTarget', { url })
      .then(({ targetId }) => this.own(targetId, agentId))
      .catch(() => undefined)
      .finally(() => {
        this.#opening.delete(id);
        this.changed();
      });
    this.changed();
    return placeholder;
  }

  navigate(id, url) {
    if (!this.#owned.has(id)) return;
    openable(url);
    void this.#session(id, (sessionId) =>
      this.#client.call('Page.navigate', { url }, sessionId)
    ).then(
      () => this.settled(id),
      () => undefined
    );
  }

  close(id) {
    if (!this.#owned.has(id)) return;
    void this.#client
      .call('Target.closeTarget', { targetId: id })
      .then(() => {
        this.forget(id);
        this.changed();
      })
      .catch(() => undefined);
  }

  async screenshot(id) {
    if (!this.#owned.has(id)) throw new Error(`not a tab SLICC is using: ${id}`);
    return this.#frames.get(id)?.src ?? this.#capture(id);
  }
}

const TRACKED = {
  'Target.createTarget': () => ({ created: true }),
  'Target.attachToTarget': (params) => ({ attach: params?.targetId }),
  'Target.detachFromTarget': (params) => ({ detached: params?.sessionId }),
  'Target.closeTarget': (params) => ({ closed: params?.targetId }),
};

function annotate(browser, link, message) {
  const params = message.params ?? {};
  if (message.method !== 'Slicc.action') return;
  if (params.phase === 'start') browser.begin(link, params);
  if (params.phase === 'end') browser.finish(link, params);
}

function observeConnection(browser, connection) {
  const sessions = new Map();
  const touched = new Set();
  const calls = new Map();
  let closed = false;
  let pending;
  const link = {
    agent: null,
    action: null,
    tab(id) {
      if (typeof id !== 'string') return null;
      if (touched.has(id) || browser.owns(id)) return id;
      pending = id;
      return null;
    },
    kill(why) {
      if (closed) return;
      outer.close();
      outer.onclose?.(why);
    },
  };
  const unlink = browser.link(link);

  const gone = (sessionId) => {
    const target = sessions.get(sessionId);
    if (!target) return;
    sessions.delete(sessionId);
    browser.state(target).sessions -= 1;
    browser.linger(target);
    browser.settled(target);
  };

  const end = () => {
    unlink();
    browser.interrupted(link);
    for (const sessionId of [...sessions.keys()]) gone(sessionId);
    void browser.refresh();
  };

  const reached = (target, created = false) => {
    touched.add(target);
    if (
      link.action?.status === 'running' &&
      !link.action.tabId &&
      (created || pending === target)
    ) {
      browser.placed(link, target);
    }
  };

  const answered = (call, message) => {
    const result = message.result ?? {};
    if (message.error) return;
    if (call.created && result.targetId) {
      browser.own(result.targetId, link.agent);
      reached(result.targetId, true);
    }
    if (call.attach && result.sessionId) {
      browser.own(call.attach, link.agent);
      sessions.set(result.sessionId, call.attach);
      browser.touch(call.attach, 1);
      reached(call.attach);
    }
    if (call.detached) gone(call.detached);
    if (call.closed) {
      browser.forget(call.closed);
      browser.changed();
    }
  };

  const outer = {
    onmessage: null,
    onclose: null,
    send(text) {
      if (closed) return;
      const message = parse(text);
      if (typeof message.method === 'string' && message.method.startsWith('Slicc.')) {
        annotate(browser, link, message);
        if (message.id === undefined) return;
        queueMicrotask(() => {
          const reply = { id: message.id, result: {} };
          if (message.sessionId) reply.sessionId = message.sessionId;
          if (!closed) outer.onmessage?.(JSON.stringify(reply));
        });
        return;
      }
      const track = TRACKED[message.method];
      if (track) calls.set(message.id, track(message.params));
      const target = sessions.get(message.sessionId);
      if (target) browser.touch(target);
      connection.send(text);
    },
    close() {
      if (closed) return;
      closed = true;
      end();
      connection.close();
    },
  };

  connection.onmessage = (text) => {
    const message = parse(text);
    const call = calls.get(message.id);
    if (call) {
      calls.delete(message.id);
      answered(call, message);
    }
    if (message.method === 'Target.detachedFromTarget') gone(message.params?.sessionId);
    if (!closed) outer.onmessage?.(text);
  };
  connection.onclose = (why) => {
    if (closed) return;
    closed = true;
    end();
    outer.onclose?.(why);
  };
  return outer;
}

export function withStop(agent, browser) {
  if (!agent || typeof agent.stop !== 'function') return agent;
  const stop = agent.stop.bind(agent);
  agent.stop = (agentId) => {
    const id = agentId ?? agent.active?.();
    stop(agentId);
    browser.stopped(id);
  };
  return agent;
}

export function createBrowser(network, options = {}) {
  const browser = new Browser(network, options);
  const port = {
    on: (type, listener) => browser.on(type, listener),
    list: () => browser.list(),
    active: () => browser.active(),
    activate: (id) => browser.activate(id),
    open: (url, agentId) => browser.open(url, agentId),
    navigate: (id, url) => browser.navigate(id, url),
    close: (id) => browser.close(id),
    screenshot: (id) => browser.screenshot(id),
    actions: (tabId) => browser.actions(tabId),
  };
  return {
    port,
    observe: (connection) => observeConnection(browser, connection),
    stopping: (agent) => withStop(agent, browser),
  };
}
