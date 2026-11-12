import { EXTENSION_UPDATE, extensionAutomationSupported } from './extension.js';
import { admits, guardProtected, NO_AUTO_ATTACH, TAB_ONLY, TAB_PREFIX } from './guard.js';

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

export const SYNC_MS = 200;

export function syntheticAutoAttach(cdp, deliver, attached, closed, every = SYNC_MS) {
  const state = { on: false, tabs: false, count: 0 };
  const seen = new Set();
  const refused = new Map();
  const tabs = new Map();
  const parents = new Map();
  let timer;
  let syncing;
  const answer = (envelope, result) => deliver({ ...envelope, result });
  const refuse = (envelope, message) => deliver({ ...envelope, error: { code: -32000, message } });
  const tabInfo = (tab) => ({
    targetId: tab.tabId,
    type: 'tab',
    title: tab.info.title ?? '',
    url: tab.info.url ?? '',
    attached: true,
    canAccessOpener: false,
    ...(tab.info.browserContextId ? { browserContextId: tab.info.browserContextId } : {}),
  });
  const attachPage = async (info, parent) => {
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    if (closed()) {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      return undefined;
    }
    attached(sessionId, 1);
    if (parent) parents.set(sessionId, parent);
    const fresh = await cdp.send('Target.getTargetInfo', { targetId: info.targetId }).then(
      ({ targetInfo }) => targetInfo,
      () => undefined
    );
    deliver({
      method: 'Target.attachedToTarget',
      ...(parent ? { sessionId: parent } : {}),
      params: {
        sessionId,
        targetInfo: { ...(fresh ?? info), attached: true },
        waitingForDebugger: false,
      },
    });
    return sessionId;
  };
  const adopt = async (info) => {
    seen.add(info.targetId);
    if (!state.tabs) {
      await attachPage(info).catch(() => {
        seen.delete(info.targetId);
        refused.set(info.targetId, info.url ?? '');
      });
      return;
    }
    state.count += 1;
    const sessionId = `slicc-tab-${state.count}-${crypto.randomUUID()}`;
    const tab = { tabId: `${TAB_PREFIX}${info.targetId}`, pageId: info.targetId, info };
    tabs.set(sessionId, tab);
    deliver({
      method: 'Target.attachedToTarget',
      params: { sessionId, targetInfo: tabInfo(tab), waitingForDebugger: false },
    });
  };
  const dropTab = (sessionId, tab) => {
    tabs.delete(sessionId);
    seen.delete(tab.pageId);
    deliver({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId: tab.tabId },
    });
  };
  const tabOf = (targetId, key = 'pageId') => [...tabs].find(([, tab]) => tab[key] === targetId);
  const fresh = (info) =>
    state.on && !seen.has(info.targetId) && refused.get(info.targetId) !== (info.url ?? '');
  const forget = (live) => {
    for (const id of refused.keys()) if (!live.has(id)) refused.delete(id);
    for (const id of [...seen]) {
      if (live.has(id)) continue;
      seen.delete(id);
      const [sessionId, tab] = tabOf(id) ?? [];
      if (tab) dropTab(sessionId, tab);
    }
  };
  const refresh = async () => {
    const { targetInfos = [] } = await cdp.send('Target.getTargets', {});
    const live = new Set();
    for (const info of targetInfos) {
      if (info.type !== 'page') continue;
      live.add(info.targetId);
      const [, tab] = tabOf(info.targetId) ?? [];
      if (tab) tab.info = info;
      else if (fresh(info)) await adopt(info);
    }
    forget(live);
  };
  const sync = () => {
    syncing ??= refresh()
      .catch(() => {})
      .finally(() => {
        syncing = undefined;
      });
    return syncing;
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const browserAuto = async (envelope, params) => {
    state.on = params?.autoAttach === true;
    state.tabs = admits(params?.filter, 'tab');
    if (state.on && (state.tabs || admits(params?.filter, 'page'))) {
      if (timer === undefined) {
        timer = setInterval(sync, every);
        timer.unref?.();
      }
      await sync();
    } else {
      state.on = false;
      stop();
    }
    answer(envelope, {});
  };
  const tabCommand = async (envelope, sessionId, method, params) => {
    const tab = tabs.get(sessionId);
    if (method === 'Runtime.runIfWaitingForDebugger') return answer(envelope, {});
    if (method === 'Target.getTargetInfo') return answer(envelope, { targetInfo: tabInfo(tab) });
    if (method === 'Target.setAutoAttach') {
      if (params?.autoAttach === true && !tab.page && admits(params.filter, 'page'))
        tab.page = await attachPage(tab.info, sessionId);
      return answer(envelope, {});
    }
    if (method === 'Target.detachFromTarget' && params?.sessionId === tab.page) {
      await cdp.send('Target.detachFromTarget', { sessionId: tab.page });
      return answer(envelope, {});
    }
    refuse(envelope, TAB_ONLY);
  };
  const browserCommand = async (envelope, method, params) => {
    if (method === 'Target.setAutoAttach') return browserAuto(envelope, params);
    if (method === 'Target.getTargetInfo')
      return answer(envelope, { targetInfo: tabInfo(tabOf(params.targetId, 'tabId')[1]) });
    const tab = tabs.get(params.sessionId);
    if (tab.page)
      await cdp.send('Target.detachFromTarget', { sessionId: tab.page }).catch(() => {});
    dropTab(params.sessionId, tab);
    refused.set(tab.pageId, tab.info.url ?? '');
    return answer(envelope, {});
  };
  const ownsBrowserCommand = (method, params) =>
    method === 'Target.setAutoAttach' ||
    (method === 'Target.detachFromTarget' && tabs.has(params?.sessionId)) ||
    (method === 'Target.getTargetInfo' && Boolean(tabOf(params?.targetId, 'tabId')));
  return {
    command(envelope, method, params, sessionId) {
      const run = tabs.has(sessionId)
        ? () => tabCommand(envelope, sessionId, method, params)
        : sessionId === undefined && ownsBrowserCommand(method, params)
          ? () => browserCommand(envelope, method, params)
          : null;
      if (!run) return false;
      void run().catch((error) => refuse(envelope, error.message));
      return true;
    },
    nudge() {
      if (state.on) void sync();
    },
    stop,
    event(event) {
      if (event.method !== 'Target.detachedFromTarget' || !parents.has(event.params?.sessionId))
        return event;
      const parent = parents.get(event.params.sessionId);
      parents.delete(event.params.sessionId);
      const tab = tabs.get(parent);
      if (tab?.page === event.params.sessionId) tab.page = undefined;
      attached(event.params.sessionId, -1);
      deliver({ ...event, sessionId: parent });
      return null;
    },
  };
}

export function extensionConnection(cdp, every) {
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
  const synthetic = syntheticAutoAttach(cdp, deliver, attached, () => closed, every);
  const off = cdp.on((raw) => {
    const event = synthetic.event(raw);
    if (!event) return;
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
      if (synthetic.command(envelope, method, params, sessionId)) return;
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
          if (method === 'Target.createTarget') synthetic.nudge();
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
      synthetic.stop();
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
      local: link.mode === 'local',
      route: { kind: 'link', version: link.peer?.version },
      open: () => link.exit.cdp(browser.id),
    }))
  );
}

export function browserVia(links) {
  const hosts = browserHosts();
  const via = RUNTIMES.find((runtime) => hosts[runtime]);
  return via ?? (linkedBrowsers(links).length ? 'link' : null);
}

function browserRoute(open, hosts, extension, fallback) {
  if (open === hosts.extension) return { kind: 'extension', version: extension.version };
  return open === hosts.devtools ? undefined : fallback?.route;
}

export function pickBrowserOpen(
  links,
  { runtime, here = false, extension = globalThis.sliccExtension } = {}
) {
  const linked = linkedBrowsers(links);
  const hosts = browserHosts(extension);
  if (runtime && !RUNTIMES.includes(runtime)) {
    const found = linked.find((browser) => browser.runtime === runtime);
    if (!found) {
      const known = [...RUNTIMES, ...linked.map((browser) => browser.runtime)];
      throw new Error(`unknown runtime "${runtime}" (${known.join(', ')})`);
    }
    return {
      open: () => found.open(),
      route: found.route,
      host: undefined,
      frames: undefined,
    };
  }
  if (extension && !extensionAutomationSupported(extension)) throw new Error(EXTENSION_UPDATE);
  const fallback = here
    ? linked.find((browser) => browser.seven && browser.local)
    : (linked.find((browser) => browser.seven) ?? linked[0]);
  const open = runtime ? hosts[runtime] : hosts.extension || hosts.devtools || fallback?.open;
  if (!open) throw new Error(MISSING[runtime ?? 'any']);
  return {
    open,
    route: browserRoute(open, hosts, extension, fallback),
    host: open === hosts.extension ? extension.cdp : undefined,
    frames:
      open === hosts.extension && typeof extension.frames === 'function'
        ? (targetId) => extension.frames(Number(targetId))
        : undefined,
  };
}

let panelLinks = () => ({ links: new Map() });

export function browserOpener(links, options = {}) {
  return () => pickBrowserOpen(links ?? panelLinks, options).open();
}

export function browserHook(
  observe = (connection) => connection,
  links,
  own = [
    globalThis.location?.origin,
    globalThis.sliccExtension?.id && `chrome-extension://${globalThis.sliccExtension.id}`,
  ].filter(Boolean),
  before = async () => {}
) {
  const tabs = new WeakMap();
  const guard = async (open, browser, route, privateFrames, caller) => {
    await before();
    if (browser && !tabs.has(browser)) {
      const records = new Map();
      browser.on((event) => {
        if (event.method === 'Target.targetDestroyed') records.delete(event.params?.targetId);
      });
      tabs.set(browser, records);
    }
    return observe(
      guardProtected(
        await open(),
        own,
        browser ? tabs.get(browser) : undefined,
        route,
        privateFrames
      ),
      { caller }
    );
  };
  return async ({ runtime, caller, here = false } = {}) => {
    const picked = pickBrowserOpen(links, { runtime, here });
    return guard(picked.open, picked.host, picked.route, picked.frames, caller);
  };
}

export function browserControl({ observe, links, before } = {}) {
  if (links) panelLinks = links;
  return {
    hook: browserHook(observe, links, undefined, before),
    status: () => ({ via: browserVia(links) }),
  };
}
