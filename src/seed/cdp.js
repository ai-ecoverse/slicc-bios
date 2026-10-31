import { EXTENSION_UPDATE, extensionAutomationSupported } from './extension.js';
import { guardProtected, NO_AUTO_ATTACH } from './guard.js';

const RUNTIMES = ['extension', 'devtools'];

export const MISSING = {
  any: 'no browser to drive: install slicc-extension, or link a computer with npx sliccy@next',
  extension: 'no browser to drive: install slicc-extension',
  devtools: 'no browser to drive: this browser offers seven no DevTools port',
};
export const PORT_CLOSED = "this browser's DevTools port didn't answer: it may have closed";
export const OPEN_WAIT = 10000;
const ANNOUNCED = -1;
const NOT_FOUND = -32601;

function command(text) {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

export function browserTargetEvent(event) {
  return (
    event?.sessionId === undefined &&
    typeof event?.method === 'string' &&
    event.method.startsWith('Target.')
  );
}

export function ordered(send) {
  let tail = Promise.resolve();
  return (text) => {
    const run = tail.then(() => send(text));
    tail = run.then(
      () => {},
      () => {}
    );
  };
}

export function extensionConnection(cdp) {
  const sessions = new Map();
  const attaching = new Set();
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
    const tracked = sessions.has(event.sessionId);
    if (!tracked && !browserTargetEvent(event)) return;
    if (
      !tracked &&
      event.method === 'Target.attachedToTarget' &&
      !sessions.has(event.params?.sessionId)
    ) {
      for (const entry of attaching)
        if (
          typeof entry.targetId === 'string' &&
          entry.targetId &&
          typeof event.params?.sessionId === 'string' &&
          event.params.targetInfo?.targetId === entry.targetId &&
          entry.events.size < 64
        )
          entry.events.set(event.params.sessionId, event);
      return;
    }
    if (tracked && event.method === 'Target.detachedFromTarget') sessions.delete(event.sessionId);
    if (tracked && event.method === 'Target.attachedToTarget' && event.params?.sessionId) {
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
      const envelope = { id, ...(sessionId !== undefined ? { sessionId } : {}) };
      if (typeof method !== 'string') {
        deliver({ ...envelope, error: { code: -32600, message: 'a command needs a method' } });
        return;
      }
      const attachment =
        method === 'Target.attachToTarget'
          ? { targetId: params?.targetId, events: new Map() }
          : undefined;
      if (attachment) attaching.add(attachment);
      cdp.send(method, params, sessionId).then(
        (result) => {
          if (attachment) attaching.delete(attachment);
          if (method === 'Target.attachToTarget' && result.sessionId) {
            if (closed) {
              cdp.send('Target.detachFromTarget', { sessionId: result.sessionId }).catch(() => {});
              return;
            }
            attached(result.sessionId, 1);
            const event = attachment.events.get(result.sessionId);
            if (event) deliver(event);
          }
          if (method === 'Target.detachFromTarget' && sessions.has(params?.sessionId)) {
            attached(params.sessionId, -1);
          }
          deliver({ ...envelope, result });
        },
        (error) => {
          if (attachment) attaching.delete(attachment);
          deliver({ ...envelope, error: { code: -32000, message: error.message } });
        }
      );
    },
    close() {
      if (closed) return;
      closed = true;
      attaching.clear();
      off();
      for (const [sessionId, count] of sessions) {
        for (let n = 0; n < count; n++) {
          cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        }
      }
      sessions.clear();
    },
  };
  connection.send = ordered(connection.send.bind(connection));
  return connection;
}

export function devtoolsConnection(
  url,
  { socket = (at) => new WebSocket(at), timers = globalThis } = {}
) {
  return new Promise((resolve, reject) => {
    const ws = socket(url);
    const attaching = new Set();
    let open = false;
    const refuse = () => {
      timers.clearTimeout(timer);
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws.close();
      reject(new Error(PORT_CLOSED));
    };
    const timer = timers.setTimeout(refuse, OPEN_WAIT);
    const connection = {
      onmessage: null,
      onclose: null,
      send(text) {
        if (!open) return;
        const { id, method } = command(text);
        if (method === 'Target.setAutoAttach') attaching.add(id);
        ws.send(text);
      },
      close() {
        if (!open) return;
        open = false;
        ws.close();
      },
    };
    ws.onerror = () => {
      if (!open) refuse();
    };
    ws.onopen = () => {
      timers.clearTimeout(timer);
      open = true;
      ws.onclose = ({ reason }) => {
        if (!open) return;
        open = false;
        connection.onclose?.(reason || PORT_CLOSED);
      };
      ws.onmessage = ({ data }) => {
        const message = command(data);
        if (message.id === ANNOUNCED) return;
        const refused = attaching.delete(message.id) && message.error?.code === NOT_FOUND;
        connection.onmessage?.(
          refused
            ? JSON.stringify({ ...message, error: { ...message.error, message: NO_AUTO_ATTACH } })
            : data
        );
      };
      ws.send(JSON.stringify({ id: ANNOUNCED, method: 'Slicc.action', params: {} }));
      resolve(connection);
    };
    ws.onclose = () => {
      if (!open) refuse();
    };
  });
}

export function browserHosts(
  extension = globalThis.sliccExtension,
  devtools = globalThis.crestDevTools
) {
  const cdp = extensionAutomationSupported(extension) ? extension?.cdp : undefined;
  const url = devtools?.webSocketDebuggerUrl;
  return {
    extension: cdp && (() => extensionConnection(cdp)),
    devtools: url && (() => devtoolsConnection(url)),
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

export function browserVia(links) {
  const hosts = browserHosts();
  const via = RUNTIMES.find((runtime) => hosts[runtime]);
  return via ?? (linkedBrowsers(links).length ? 'link' : null);
}

export function browserHook(
  observe = (connection) => connection,
  links,
  own = globalThis.location?.origin,
  before = async () => {}
) {
  const tabs = new WeakMap();
  const guard = async (open, browser) => {
    await before();
    if (browser && !tabs.has(browser)) {
      const records = new Map();
      browser.on((event) => {
        if (event.method === 'Target.targetDestroyed') records.delete(event.params?.targetId);
      });
      tabs.set(browser, records);
    }
    return observe(guardProtected(await open(), own, browser ? tabs.get(browser) : undefined));
  };
  return async ({ runtime } = {}) => {
    const linked = linkedBrowsers(links);
    const extension = globalThis.sliccExtension;
    const hosts = browserHosts(extension);
    if (runtime && !RUNTIMES.includes(runtime)) {
      const found = linked.find((browser) => browser.runtime === runtime);
      if (!found) {
        const known = [...RUNTIMES, ...linked.map((browser) => browser.runtime)];
        throw new Error(`unknown runtime "${runtime}" (${known.join(', ')})`);
      }
      return guard(() => found.open());
    }
    if (extension && !extensionAutomationSupported(extension)) throw new Error(EXTENSION_UPDATE);
    const fallback = linked.find((browser) => browser.seven) ?? linked[0];
    const open = runtime ? hosts[runtime] : hosts.extension || hosts.devtools || fallback?.open;
    if (!open) throw new Error(MISSING[runtime ?? 'any']);
    return guard(open, open === hosts.extension ? extension.cdp : undefined);
  };
}

export function browserControl({ observe, links, before } = {}) {
  return {
    hook: browserHook(observe, links, undefined, before),
    status: () => ({ via: browserVia(links) }),
  };
}
