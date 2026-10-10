import { browserHosts } from './cdp.js';

export const HOLD = 10000;
export const FRESH = 2000;
export const SHOT_GAP = 1000;
export const SHOT_WIDTH = 960;
export const CALL_TIMEOUT = 10000;
const KEY = 'slicc-os.browser.tabs';
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
      status: 'complete',
      agentId: this.#owned.get(id) ?? null,
      controlled: this.#controlled(id),
    };
  }

  list() {
    if (this.#now() - this.#refreshed > FRESH) void this.refresh();
    const known = [...this.#owned.keys()].filter((id) => this.#infos.has(id));
    return [...known.map((id) => this.#tab(id)), ...this.#opening.values()];
  }

  active() {
    return [...this.#owned.keys()].find((id) => this.#infos.get(id)?.active) ?? null;
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

  touch(id) {
    const entry = this.state(id);
    const was = this.#controlled(id);
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
    void this.#client.call('Target.activateTarget', { targetId: id }).catch(() => undefined);
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

function observeConnection(browser, connection) {
  const sessions = new Map();
  const calls = new Map();
  let closed = false;

  const gone = (sessionId) => {
    const target = sessions.get(sessionId);
    if (!target) return;
    sessions.delete(sessionId);
    browser.state(target).sessions -= 1;
    browser.linger(target);
    browser.settled(target);
  };

  const end = () => {
    for (const sessionId of [...sessions.keys()]) gone(sessionId);
    void browser.refresh();
  };

  const answered = (call, message) => {
    const result = message.result ?? {};
    if (message.error) return;
    if (call.created) browser.own(result.targetId);
    if (call.attach && result.sessionId) {
      browser.own(call.attach);
      sessions.set(result.sessionId, call.attach);
      browser.state(call.attach).sessions += 1;
      browser.touch(call.attach);
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
        if (message.id === undefined) return;
        queueMicrotask(() => {
          if (!closed) outer.onmessage?.(JSON.stringify({ id: message.id, result: {} }));
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
  };
  return { port, observe: (connection) => observeConnection(browser, connection) };
}
