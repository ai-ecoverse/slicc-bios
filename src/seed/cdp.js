const PROTOCOL = 'slicc.cdp.v1';
const RUNTIMES = ['extension', 'proxy'];

export const MISSING = {
  any: 'no browser to drive: install slicc-extension, or run npx @ai-ecoverse/slicc-node',
  extension: 'no browser to drive: install slicc-extension',
  proxy: 'no browser to drive: run npx @ai-ecoverse/slicc-node',
};

function command(text) {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

export function extensionConnection(cdp) {
  const sessions = new Map();
  let closed = false;
  const deliver = (message) => {
    if (!closed) connection.onmessage?.(JSON.stringify(message));
  };
  const attached = (sessionId, by) => {
    const count = (sessions.get(sessionId) ?? 0) + by;
    if (count > 0) sessions.set(sessionId, count);
    else sessions.delete(sessionId);
  };
  const off = cdp.on((event) => {
    if (!sessions.has(event.sessionId)) return;
    if (event.method === 'Target.detachedFromTarget') sessions.delete(event.sessionId);
    if (event.method === 'Target.attachedToTarget' && event.params?.sessionId) {
      attached(event.params.sessionId, 1);
    }
    deliver(event);
  });
  const connection = {
    onmessage: null,
    onclose: null,
    send(text) {
      if (closed) return;
      const { id, method, params, sessionId } = command(text);
      if (typeof method !== 'string') {
        deliver({ id, error: { code: -32600, message: 'a command needs a method' } });
        return;
      }
      cdp.send(method, params, sessionId).then(
        (result) => {
          if (method === 'Target.attachToTarget' && result.sessionId) {
            if (closed) {
              cdp.send('Target.detachFromTarget', { sessionId: result.sessionId }).catch(() => {});
              return;
            }
            attached(result.sessionId, 1);
          }
          if (method === 'Target.detachFromTarget' && sessions.has(params?.sessionId)) {
            attached(params.sessionId, -1);
          }
          deliver({ id, result });
        },
        (error) => deliver({ id, error: { code: -32000, message: error.message } })
      );
    },
    close() {
      if (closed) return;
      closed = true;
      off();
      for (const [sessionId, count] of sessions) {
        for (let n = 0; n < count; n++) {
          cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        }
      }
      sessions.clear();
    },
  };
  return connection;
}

const CLOSED = {
  4001: 'another page took over the local proxy’s browser connection',
  4002: 'the local proxy lost its browser',
};

function openSocket(proxy) {
  const url = new URL('/cdp', proxy.url);
  url.protocol = 'ws:';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [PROTOCOL, `slicc.key.${proxy.key}`]);
    socket.onopen = () => {
      if (socket.protocol === PROTOCOL) resolve(socket);
      else socket.close();
    };
    socket.onclose = () =>
      reject(new Error(`the local proxy at ${url.host} did not open a browser session`));
  });
}

export function proxyHost(proxy) {
  const host = new URL(proxy.url).host;
  const pending = new Map();
  const owners = new Map();
  const connections = new Set();
  let socket;
  let next = 0;

  const forward = (message) => {
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      if (call.done) call.done(message);
      if (!call.connection) return;
      call.connection.deliver({ ...message, id: call.id });
      return;
    }
    if (message.id !== undefined) return;
    const parent = message.sessionId;
    const child = message.params?.sessionId;
    if (message.method === 'Target.attachedToTarget' && child && owners.has(parent)) {
      owners.set(child, owners.get(parent));
    }
    const owner = owners.get(parent ?? child);
    if (message.method === 'Target.detachedFromTarget' && child) owners.delete(child);
    if (owner) owner.deliver(message);
    else if (parent === undefined) for (const each of connections) each.deliver(message);
  };

  const lost = (code, reason) => {
    const why = `${CLOSED[code] ?? `the local proxy at ${host} closed its browser connection`}${reason ? ` (${reason})` : ''}`;
    socket = undefined;
    pending.clear();
    owners.clear();
    for (const each of [...connections]) each.drop(why);
  };

  const ensure = () => {
    if (socket) return socket;
    const opening = openSocket(proxy).then(
      (opened) => {
        opened.onmessage = ({ data }) => {
          if (typeof data === 'string') forward(command(data));
        };
        opened.onclose = ({ code, reason }) => {
          if (socket === opening) lost(code, reason);
        };
        return opened;
      },
      (error) => {
        if (socket === opening) socket = undefined;
        throw error;
      }
    );
    socket = opening;
    return opening;
  };

  const post = async (message, call) => {
    const opened = await ensure();
    const id = ++next;
    pending.set(id, call);
    opened.send(JSON.stringify({ ...message, id }));
  };

  return async () => {
    await ensure();
    let closed = false;
    const sessions = () => [...owners].filter(([, owner]) => owner === connection);
    const connection = {
      onmessage: null,
      onclose: null,
      deliver(message) {
        if (!closed) connection.onmessage?.(JSON.stringify(message));
      },
      drop(why) {
        if (closed) return;
        closed = true;
        connections.delete(connection);
        connection.onclose?.(why);
      },
      send(text) {
        if (closed) return;
        const message = command(text);
        if (typeof message.method !== 'string') {
          connection.deliver({
            id: message.id,
            error: { code: -32600, message: 'a command needs a method' },
          });
          return;
        }
        const done =
          message.method === 'Target.attachToTarget' ||
          message.method === 'Target.attachToBrowserTarget'
            ? (reply) => {
                if (!reply.result?.sessionId) return;
                if (closed)
                  void post(
                    {
                      method: 'Target.detachFromTarget',
                      params: { sessionId: reply.result.sessionId },
                    },
                    {}
                  );
                else owners.set(reply.result.sessionId, connection);
              }
            : undefined;
        post(message, { connection, id: message.id, done }).catch((error) =>
          connection.deliver({ id: message.id, error: { code: -32000, message: error.message } })
        );
      },
      close() {
        if (closed) return;
        closed = true;
        connections.delete(connection);
        for (const [sessionId] of sessions()) {
          owners.delete(sessionId);
          void post({ method: 'Target.detachFromTarget', params: { sessionId } }, {}).catch(
            () => {}
          );
        }
        for (const [id, call] of pending)
          if (call.connection === connection) pending.set(id, { done: call.done });
        if (connections.size === 0 && socket) {
          const closing = socket;
          socket = undefined;
          void closing.then((opened) => opened.close());
        }
      },
    };
    connections.add(connection);
    return connection;
  };
}

const proxies = new WeakMap();

export function browserHosts(network) {
  const extension = globalThis.sliccExtension?.cdp;
  const proxy = network.kind === 'local-proxy' && network.status?.probe?.cdp;
  if (proxy && !proxies.has(network.proxy)) proxies.set(network.proxy, proxyHost(network.proxy));
  return {
    extension: extension && (() => extensionConnection(extension)),
    proxy: proxy && proxies.get(network.proxy),
  };
}

export function linkedBrowsers(links) {
  return [...(links?.()?.links.values() ?? [])].flatMap((link) =>
    link.exit.browsers().map((browser) => ({
      runtime: `${link.label}/${browser.id}`,
      seven: browser.seven,
      open: () => link.exit.cdp(browser.id),
    }))
  );
}

export function browserVia(network, links) {
  const hosts = browserHosts(network);
  const via = RUNTIMES.find((runtime) => hosts[runtime]);
  return via ?? (linkedBrowsers(links).length ? 'link' : null);
}

export function browserHook(
  network,
  observe = (connection) => connection,
  links,
  own = globalThis.location?.origin
) {
  const guard = (connection) => observe(guardOwnOrigin(connection, own));
  return async ({ runtime } = {}) => {
    const linked = linkedBrowsers(links);
    const hosts = browserHosts(network);
    if (runtime && !RUNTIMES.includes(runtime)) {
      const found = linked.find((browser) => browser.runtime === runtime);
      if (!found) {
        const known = [...RUNTIMES, ...linked.map((browser) => browser.runtime)];
        throw new Error(`unknown runtime "${runtime}" (${known.join(', ')})`);
      }
      return guard(await found.open());
    }
    const fallback = linked.find((browser) => browser.seven) ?? linked[0];
    const open = runtime ? hosts[runtime] : hosts.extension || hosts.proxy || fallback?.open;
    if (!open) throw new Error(MISSING[runtime ?? 'any']);
    return guard(await open());
  };
}

export function browserControl(network, { observe, links } = {}) {
  return {
    hook: browserHook(network, observe, links),
    status: () => ({ via: browserVia(network, links) }),
  };
}

const GUARD_IDS = 2 ** 30;
export const OWN = 'seven’s own pages are out of reach of browser automation';

const urlOrigin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export function guardOwnOrigin(connection, own) {
  const isOwn = (url) => urlOrigin(url) === own;
  const urls = new Map();
  const sessions = new Map();
  const blocked = new Set();
  const internal = new Map();
  let next = GUARD_IDS;
  const guarded = { onmessage: null, onclose: null };
  const deliver = (message) => guarded.onmessage?.(JSON.stringify(message));
  const call = (method, params, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      internal.set(next, resolve);
      connection.send(
        JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })
      );
    });
  const learn = (info) => {
    if (info?.targetId) urls.set(info.targetId, info.url ?? '');
  };
  const cut = (sessionId) => {
    blocked.add(sessionId);
    void call('Target.detachFromTarget', { sessionId });
  };
  const refuse = (id) => deliver({ id, error: { code: -32000, message: OWN } });
  const targetUrl = async (targetId) => {
    if (!urls.has(targetId))
      learn((await call('Target.getTargetInfo', { targetId })).result?.targetInfo);
    return urls.get(targetId);
  };

  function event(message) {
    const { method, params = {} } = message;
    if (method === 'Target.attachedToTarget') {
      learn(params.targetInfo);
      sessions.set(params.sessionId, params.targetInfo?.targetId);
      if (isOwn(params.targetInfo?.url)) return cut(params.sessionId);
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      learn(params.targetInfo);
      if (isOwn(params.targetInfo?.url)) {
        for (const [sessionId, targetId] of sessions)
          if (targetId === params.targetInfo.targetId && !blocked.has(sessionId)) cut(sessionId);
        return;
      }
    }
    if (method === 'Target.detachedFromTarget') sessions.delete(params.sessionId);
    if (blocked.has(message.sessionId)) return;
    deliver(message);
  }

  function answer(message, asked) {
    if (asked?.method === 'Target.attachToTarget' && message.result?.sessionId)
      sessions.set(message.result.sessionId, asked.params?.targetId);
    if (asked?.method === 'Target.getTargets' && Array.isArray(message.result?.targetInfos)) {
      for (const info of message.result.targetInfos) learn(info);
      const targetInfos = message.result.targetInfos.filter((info) => !isOwn(info.url));
      return deliver({ ...message, result: { ...message.result, targetInfos } });
    }
    deliver(message);
  }

  const asked = new Map();
  connection.onmessage = (text) => {
    const message = command(text);
    if (internal.has(message.id)) {
      const resolve = internal.get(message.id);
      internal.delete(message.id);
      return resolve(message);
    }
    if (message.id === undefined) return event(message);
    const was = asked.get(message.id);
    asked.delete(message.id);
    answer(message, was);
  };
  connection.onclose = (why) => guarded.onclose?.(why);

  async function check({ method, params = {}, sessionId }) {
    if (sessionId && blocked.has(sessionId)) return false;
    if (method === 'Target.attachToTarget') return !isOwn(await targetUrl(params.targetId));
    if (method === 'Target.createTarget' || method === 'Page.navigate') return !isOwn(params.url);
    return true;
  }

  let order = Promise.resolve();
  guarded.send = (text) => {
    const message = command(text);
    order = order
      .then(() => check(message))
      .then((ok) => {
        if (!ok) return refuse(message.id);
        asked.set(message.id, message);
        connection.send(text);
      });
  };
  guarded.close = () => connection.close();
  return guarded;
}
