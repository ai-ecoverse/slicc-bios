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

export function proxyConnection(proxy) {
  const url = new URL('/cdp', proxy.url);
  url.protocol = 'ws:';
  const host = url.host;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [PROTOCOL, `slicc.key.${proxy.key}`]);
    let open = false;
    const connection = {
      onmessage: null,
      onclose: null,
      send(text) {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
      close() {
        socket.close();
      },
    };
    socket.onopen = () => {
      if (socket.protocol !== PROTOCOL) {
        socket.close();
        return;
      }
      open = true;
      resolve(connection);
    };
    socket.onmessage = ({ data }) => {
      if (typeof data === 'string') connection.onmessage?.(data);
    };
    socket.onclose = ({ reason }) => {
      if (open) connection.onclose?.(reason || undefined);
      else reject(new Error(`the local proxy at ${host} did not open a browser session`));
    };
  });
}

export function browserHook(network) {
  return async ({ runtime } = {}) => {
    if (runtime && !RUNTIMES.includes(runtime)) {
      throw new Error(`unknown runtime "${runtime}" (${RUNTIMES.join(', ')})`);
    }
    const extension = globalThis.sliccExtension?.cdp;
    const proxy = network.kind === 'local-proxy' && network.status?.probe?.cdp;
    const hosts = {
      extension: extension && (() => extensionConnection(extension)),
      proxy: proxy && (() => proxyConnection(network.proxy)),
    };
    const open = runtime ? hosts[runtime] : hosts.extension || hosts.proxy;
    if (!open) throw new Error(MISSING[runtime ?? 'any']);
    return open();
  };
}
