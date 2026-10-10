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

export function browserVia(network) {
  const hosts = browserHosts(network);
  return RUNTIMES.find((runtime) => hosts[runtime]) ?? null;
}

export function browserHook(network, observe = (connection) => connection) {
  return async ({ runtime } = {}) => {
    if (runtime && !RUNTIMES.includes(runtime)) {
      throw new Error(`unknown runtime "${runtime}" (${RUNTIMES.join(', ')})`);
    }
    const hosts = browserHosts(network);
    const open = runtime ? hosts[runtime] : hosts.extension || hosts.proxy;
    if (!open) throw new Error(MISSING[runtime ?? 'any']);
    return observe(await open());
  };
}

export function browserControl(network, { observe } = {}) {
  return { hook: browserHook(network, observe), status: () => ({ via: browserVia(network) }) };
}
