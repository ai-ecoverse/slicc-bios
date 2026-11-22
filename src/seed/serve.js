import { Bridge } from './bridge.js';
import { asker, refused, who } from './requests.js';
import { httpRelay } from './serve-http.js';
import { createServeHub, serveHubBase } from './serve-hub.js';
import { createSnapshots, snapshotOptions, snapshotPrompt, snapshotStore } from './snapshot.js';

export const SERVED_PREFIX = '/srv/serve/';
export const PREVIEWS_SWITCH = { key: 'previews', label: 'Public previews' };
export const PREVIEWS_OFF = "public previews are off in seven's settings";
export const SERVING = 'Serving publicly';
export const STOPPED = 'stopped in seven';
export const STOPPED_BY_COMMAND = 'stopped with serve --stop';
export const REVOKED = 'revoked by the serve hub';
export const SWITCHED_OFF = 'public previews were switched off';
export const LOST = 'seven lost its serve host';
export const DISMISSED = 'the request to publish was dismissed';
export const LATE = 'nobody answered the request to publish within 60 s';
export const NO_HUB = 'seven publishes previews only through the serve hub, and it has none here';
export const ELSEWHERE =
  "seven publishes only from the tab that runs its kernel; run serve in that tab's terminal";
export const UNKNOWN = 'the serve hub has no such preview';
export const LEGACY =
  'lives on the tray hub, which seven no longer publishes through, so it ends only at its expiry';
export const MAX_TABS = 100;
export const DEFAULT_TABS = 20;
export const WEBHOOKS_DIR = '/root/.slicc/webhooks';
const KEEP_WEBHOOKS =
  'dir=$1 name=$2 entry=$3; shift 3; mkdir -p "$dir" || exit 1; for f in "$dir"/serve-????????????????.json; do [ -e "$f" ] || continue; b=${f##*/}; b=${b%.json}; keep=; for h in "$@"; do [ "$h" = "$b" ] && keep=1; done; [ -n "$keep" ] || rm -f "$f"; done; printf \'%s\\n\' "$entry" > "$dir/$name.json"';

const encoder = new TextEncoder();

export function entryOf(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const parts = value.replaceAll('\\', '/').split('/');
  if (value.startsWith('/') || value.includes('\0')) return undefined;
  if (parts.some((part) => !part || part === '.' || part === '..')) return undefined;
  return parts.join('/');
}

export function publicUrl(url, explicit) {
  if (explicit || !url.endsWith('/index.html')) return url;
  return url.slice(0, -'index.html'.length);
}

export function serveId(random = () => crypto.getRandomValues(new Uint8Array(16))) {
  return [...random()].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function bridgeOptions(options) {
  if (options?.bridge !== true) return null;
  const maxTabs = options.maxTabs ?? DEFAULT_TABS;
  if (!Number.isInteger(maxTabs) || maxTabs < 1 || maxTabs > MAX_TABS)
    throw new TypeError('invalid maxTabs');
  return { maxTabs, quiet: options.quiet === true };
}

export function webhookEntry(url) {
  return JSON.stringify({
    target: 'cone',
    message: `An event from a visitor's tab on the bridged preview ${url} (serve --bridge)`,
  });
}

export function previewWebhooks(run) {
  return {
    keep: (name, url, held) =>
      run(['bash', '-c', KEEP_WEBHOOKS, 'serve', WEBHOOKS_DIR, name, webhookEntry(url), ...held]),
    drop: (name) => run(['rm', '-f', `${WEBHOOKS_DIR}/${name}.json`]),
  };
}

const listed = (entry) => ({
  previewToken: entry.previewToken,
  url: entry.url,
  ...(entry.root ? { root: entry.root } : {}),
  port: entry.port,
  ...(entry.entry ? { entry: entry.entry } : {}),
  since: entry.since,
});

export function mintedBridge(wanted) {
  if (!wanted) return {};
  return { bridge: true, maxTabs: wanted.maxTabs, quiet: wanted.quiet };
}

export function previewBridge({ hub, deliver, timers, warn, webhooks, entries }) {
  const bridge = new Bridge({
    send: (message) => hub?.send(message) === true,
    deliver: (name, delivery) => deliver?.(name, delivery),
    timers,
    warn,
  });
  return {
    bridge,
    async add(item, wanted) {
      item.bridged = bridge.add({
        token: item.previewToken,
        url: item.url,
        title: item.root || `127.0.0.1:${item.port}`,
        quiet: wanted.quiet,
        webhook: item.webhook,
        uid: item.uid,
      });
      const held = [...entries.values()].map((entry) => entry.webhook).filter(Boolean);
      await Promise.resolve()
        .then(() => webhooks?.keep(item.webhook, item.url, held))
        .catch((error) => warn(`serve: adding the webhook ${item.webhook}: ${error.message}`));
    },
    drop(entry) {
      entry.bridged?.remove();
      if (!entry.webhook) return;
      Promise.resolve()
        .then(() => webhooks?.drop(entry.webhook))
        .catch((error) => warn(`serve: removing the webhook ${entry.webhook}: ${error.message}`));
    },
  };
}

export function previewItem({ name, port, root, entry, stamp, hostId, since }) {
  return {
    id: name,
    port,
    root,
    entry,
    tag: `${SERVED_PREFIX}${name}`,
    stamp,
    uid: stamp?.uid ?? null,
    hostId,
    since,
    previewToken: null,
    url: null,
    webhook: null,
    bridged: null,
    listeners: new Set(),
  };
}

export const entryUrl = (entry) => `/${entry ?? ''}`;

export function orphansOf(listed, held) {
  const previews = Array.isArray(listed.value?.previews) ? listed.value.previews : [];
  return previews.filter(
    (preview) =>
      typeof preview?.previewToken === 'string' &&
      preview.mode === 'live' &&
      typeof preview.tag === 'string' &&
      preview.tag.startsWith(SERVED_PREFIX) &&
      !held.has(preview.previewToken) &&
      !held.has(preview.tag)
  );
}

function hubMessages({ hub, bridge, relay, snapshots, entries, byToken, end, sweep, warn }) {
  return {
    hello: () => {
      bridge.control.relinked();
      const hostId = hub.hostId();
      for (const entry of [...entries.values()])
        if (entry.previewToken && entry.hostId !== hostId) end(entry, LOST, false);
      return sweep().catch((error) =>
        warn(`serve: listing the serve hub's previews: ${error.message}`)
      );
    },
    'preview.revoked': (message) => {
      snapshots.revoked(message.previewToken);
      const entry = byToken(message.previewToken);
      if (entry) end(entry, REVOKED, false);
    },
    'preview.state': (message) => bridge.control.state(message),
    'bridge.connected': (message) => bridge.control.connected(message),
    'bridge.disconnected': (message) => bridge.control.disconnected(message),
    'bridge.cdp.response': (message) => bridge.control.responded(message),
    'bridge.emit': (message) => bridge.control.emitted(message),
    'http.request': (message) => relay.request(message),
    'http.request.end': (message) => relay.end(message),
    'http.ack': (message) => relay.ack(message),
    'http.cancel': (message) => relay.cancel(message),
  };
}

export function createPreviews({
  hub,
  dial,
  deliver = null,
  timers = globalThis,
  id = serveId,
  now = Date.now,
  warn = (message) => console.warn(message),
  store = snapshotStore({ now }),
  webhooks = null,
}) {
  const entries = new Map();
  const bridging = previewBridge({ hub, deliver, timers, warn, webhooks, entries });
  const { bridge } = bridging;
  const snapshots = createSnapshots({
    hub,
    refusal: hubRefusal,
    store,
    id,
    now,
    warn,
    prefix: SERVED_PREFIX,
    publicUrl,
    entryUrl,
    ready: () => {
      if (!hub) throw new DOMException(NO_HUB, 'NotSupportedError');
    },
  });
  const visible = (entry, uid) => uid === 0 || entry.uid === uid;
  const byToken = (token) =>
    [...entries.values()].find((entry) => entry.previewToken === token) ?? null;
  const relay = httpRelay({
    dial: (options) => dial(options),
    send: (message) => hub?.send(message) === true,
    origin: byToken,
  });

  async function revoke(token) {
    const stopped = await hub.stop(token);
    if (stopped.ok) return true;
    if (stopped.status === 404) return false;
    throw new Error(stopped.value?.error ?? `the serve hub answered ${stopped.status}`);
  }

  function end(entry, reason, revoking) {
    if (entries.get(entry.id) !== entry) return false;
    entries.delete(entry.id);
    relay.drop(entry.previewToken);
    bridging.drop(entry);
    for (const listener of [...entry.listeners]) listener(reason);
    if (revoking && entry.previewToken)
      revoke(entry.previewToken).catch((error) =>
        warn(`serve: revoking the preview ${entry.previewToken}: ${error.message}`)
      );
    return true;
  }

  async function publish({ port, root = '', entry = null, stamp = null, bridge: wanted = null }) {
    if (!hub) throw new DOMException(NO_HUB, 'NotSupportedError');
    await hub.connect();
    const name = id();
    const item = previewItem({
      name,
      port,
      root,
      entry,
      stamp,
      hostId: hub.hostId(),
      since: now(),
    });
    item.webhook = wanted ? `serve-${id().slice(0, 16)}` : null;
    entries.set(name, item);
    let minted;
    try {
      minted = await hub.mint({ entry: entryUrl(entry), tag: item.tag, ...mintedBridge(wanted) });
    } catch (error) {
      entries.delete(name);
      throw error;
    }
    const answer = hubRefusal(minted);
    if (answer) {
      entries.delete(name);
      return { refused: answer };
    }
    const { previewToken, url } = minted.value;
    if (typeof previewToken !== 'string' || typeof url !== 'string') {
      entries.delete(name);
      throw new Error("the serve hub's mint answer has no previewToken or url");
    }
    item.previewToken = previewToken;
    item.hostId = hub.hostId();
    item.url = publicUrl(url, entry !== null);
    if (entries.get(name) !== item) {
      await revoke(previewToken).catch(() => undefined);
      throw new DOMException(STOPPED, 'AbortError');
    }
    if (wanted) await bridging.add(item, wanted);
    return {
      id: name,
      url: item.url,
      previewToken,
      ...(item.webhook ? { webhook: item.webhook } : {}),
      on(listener) {
        item.listeners.add(listener);
        return () => item.listeners.delete(listener);
      },
      events: (listener) => item.bridged?.on(listener) ?? (() => undefined),
      stop: (reason = STOPPED) => end(item, reason, true),
    };
  }

  async function sweep() {
    const listed = await hub.list();
    if (!listed.ok) return;
    const held = new Set([...entries.values()].flatMap((entry) => [entry.previewToken, entry.tag]));
    for (const preview of orphansOf(listed, held))
      await revoke(preview.previewToken).catch((error) =>
        warn(`serve: revoking the preview ${preview.previewToken}: ${error.message}`)
      );
  }

  const lose = () => {
    for (const entry of [...entries.values()]) end(entry, LOST, false);
  };

  const messages = hubMessages({
    hub,
    bridge,
    relay,
    snapshots,
    entries,
    byToken,
    end,
    sweep,
    warn,
  });

  return {
    publish,
    bridge,
    snapshot: snapshots.snapshot,
    list: (uid = 0) => [
      ...[...entries.values()]
        .filter((entry) => entry.previewToken && visible(entry, uid))
        .map(listed),
      ...snapshots.list(uid),
    ],
    async stop(token, uid = 0) {
      const entry = byToken(token);
      const kept = entry ? false : snapshots.held(token, uid);
      if ((entry && !visible(entry, uid)) || kept === null)
        throw new DOMException(UNKNOWN, 'NotFoundError');
      if (entry) end(entry, STOPPED_BY_COMMAND, false);
      const revoked = await revoke(token);
      if (kept && !revoked && snapshots.legacy(token))
        throw new Error(`the snapshot ${token} ${LEGACY}`);
      if (kept) snapshots.revoked(token);
      if (!revoked && !entry && !kept) throw new DOMException(UNKNOWN, 'NotFoundError');
    },
    stopAll(reason) {
      for (const entry of [...entries.values()]) end(entry, reason, true);
    },
    start() {
      if (!hub.hostId()) return Promise.resolve();
      return sweep().catch((error) =>
        warn(`serve: listing the serve hub's previews: ${error.message}`)
      );
    },
    hub: {
      message: (message) => messages[message?.type]?.(message),
      binary: (data) => relay.body(data),
      closed: () => relay.closeAll(),
      lost: lose,
    },
  };
}

const LINK_LOGIN = /<([^>]+)>\s*;[^,]*\brel="?login"?/i;

export function hubRefusal(minted) {
  const { status } = minted;
  if (status >= 200 && status < 300) return null;
  const value = minted.value ?? {};
  const headers = minted.headers ?? new Headers();
  const signIn =
    (typeof value.signIn === 'string' && value.signIn) ||
    LINK_LOGIN.exec(headers.get('link') ?? '')?.[1] ||
    null;
  const retryAfter = headers.get('retry-after');
  return {
    error: (typeof value.error === 'string' && value.error) || `the serve hub answered ${status}`,
    status,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(signIn ? { signIn } : {}),
  };
}

export function publishPrompt({ stamp, options }) {
  const root =
    typeof options?.root === 'string' && options.root
      ? options.root
      : `the server on port ${options?.port}`;
  const bridged = options?.bridge === true;
  return {
    title: bridged
      ? `Publish ${root} at a public URL, and let the agent drive the tabs of whoever opens it?`
      : `Publish ${root} at a public URL?`,
    body: bridged
      ? `${asker(stamp)} asks seven to publish ${root} at a public URL with the bridge. Anyone with the link can open it while it is served, and the agent can read and drive the tabs they open on it.`
      : `${asker(stamp)} asks seven to publish ${root} at a public URL. Anyone with the link can open it while it is served.`,
    action: 'Publish',
    cancel: 'Cancel',
    variant: 'confirmation',
    dismissed: DISMISSED,
    late: LATE,
  };
}

export function line(value) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

const PORT_MAX = 65535;

export function portOf(value) {
  return Number.isInteger(value) && value > 0 && value <= PORT_MAX ? value : null;
}

export function serveRequests({ previews, here = () => true, on, live }) {
  const owner = () => {
    const registry = previews();
    if (!registry) throw new DOMException(NO_HUB, 'NotSupportedError');
    if (!here()) throw new DOMException(ELSEWHERE, 'NotSupportedError');
    return registry;
  };
  const enabled = () => {
    if (!on()) throw refused(PREVIEWS_OFF);
  };
  return {
    'serve.publish': async (request, { gesture }) => {
      const { options, stamp, signal } = request;
      const port = portOf(options?.port);
      if (port === null) throw new TypeError('invalid port');
      const entry = entryOf(options?.entry);
      if (entry === undefined) throw new TypeError('invalid entry');
      const root = typeof options?.root === 'string' ? options.root : '';
      const bridge = bridgeOptions(options);
      enabled();
      const registry = owner();
      await gesture(stamp, publishPrompt(request), signal);
      enabled();
      const published = await registry.publish({
        port,
        root,
        entry,
        stamp,
        bridge,
      });
      if (published.refused) {
        if (signal?.aborted) throw signal.reason;
        return line(published.refused);
      }
      if (signal?.aborted) {
        published.stop();
        throw signal.reason;
      }
      let controller = null;
      let chip = null;
      let events = null;
      const finish = (reason) => {
        signal?.removeEventListener('abort', abort);
        chip?.();
        chip = null;
        events?.();
        events = null;
        if (!controller) return;
        const ending = controller;
        controller = null;
        try {
          ending.enqueue(line({ stopped: reason }));
          ending.close();
        } catch {}
      };
      const abort = () => {
        controller?.close();
        controller = null;
        published.stop();
      };
      published.on(finish);
      signal?.addEventListener('abort', abort, { once: true });
      chip = live.add({
        kind: 'preview',
        label: SERVING,
        what: root || `port ${port}`,
        asker: who(stamp),
        action: { label: 'Stop', run: () => published.stop() },
      });
      return new ReadableStream(
        {
          start(given) {
            controller = given;
            given.enqueue(
              line({
                url: published.url,
                previewToken: published.previewToken,
                ...(published.webhook ? { webhook: published.webhook } : {}),
              })
            );
            events = published.events((record) => controller?.enqueue(line(record)));
          },
          cancel: () => {
            controller = null;
            published.stop();
          },
        },
        { highWaterMark: 0 }
      );
    },
    'serve.snapshot': async (request, { gesture }) => {
      const { options, stamp, signal } = request;
      const entry = entryOf(options?.entry);
      if (entry === undefined) throw new TypeError('invalid entry');
      const { ttlMs, files, bytes } = snapshotOptions(options);
      const root = typeof options?.root === 'string' ? options.root : '';
      enabled();
      const registry = owner();
      await gesture(stamp, snapshotPrompt(request), signal);
      enabled();
      const done = await registry.snapshot({
        root,
        entry,
        ttlMs,
        counts: { files, bytes },
        stamp,
        body: request.body,
        signal,
        progress: (text) => request.progress?.(text),
      });
      if (done.refused) return `${JSON.stringify(done.refused)}\n`;
      const { url, previewToken, expiresAt } = done.item;
      return `${JSON.stringify({ url, previewToken, expiresAt, files, bytes })}\n`;
    },
    'serve.list': async ({ stamp }) => {
      const lines = owner()
        .list(stamp?.uid ?? 0)
        .map((item) => JSON.stringify(item));
      return lines.length ? `${lines.join('\n')}\n` : '';
    },
    'serve.stop': async ({ options, stamp }) => {
      const token = options?.previewToken;
      if (typeof token !== 'string' || !token)
        throw new TypeError('serve.stop needs a previewToken');
      await owner().stop(token, stamp?.uid ?? 0);
    },
    'serve.logs': async ({ options, stamp }) => {
      const lines = owner()
        .bridge.logs(tokenOf(options), stamp?.uid ?? 0)
        .map((item) => JSON.stringify(item));
      return lines.length ? `${lines.join('\n')}\n` : '';
    },
    'serve.truncate': async ({ options, stamp }) =>
      `${JSON.stringify(owner().bridge.truncate(tokenOf(options), stamp?.uid ?? 0))}\n`,
  };
}

export function tokenOf(options) {
  const token = options?.previewToken;
  if (token === undefined || token === null) return null;
  if (typeof token !== 'string' || !token) throw new TypeError('invalid previewToken');
  return token;
}

export function publicPreviews({
  base,
  kernel,
  switches,
  live,
  deliver,
  fetch: fetcher = (...args) => fetch(...args),
  WebSocket: Socket = globalThis.WebSocket,
  storage = globalThis.localStorage,
}) {
  let previews = null;
  const hub = base
    ? createServeHub({
        base,
        fetch: fetcher,
        WebSocket: Socket,
        storage,
        on: {
          message: (message) => previews?.hub.message(message),
          binary: (data) => previews?.hub.binary(data),
          closed: () => previews?.hub.closed(),
          replaced: () => previews?.hub.lost(),
          deleted: () => previews?.hub.lost(),
        },
      })
    : null;
  previews = base
    ? createPreviews({
        hub,
        dial: (options) => kernel().dial(options),
        deliver,
        webhooks: previewWebhooks(async (argv) => {
          const { status, stderr } = await kernel().run(argv, { cwd: '/' });
          if (status !== 0) throw new Error(stderr?.trim() || `${argv[0]} exited ${status}`);
        }),
      })
    : null;
  const toggle = switches.add({ ...PREVIEWS_SWITCH, off: () => previews?.stopAll(SWITCHED_OFF) });
  return {
    start: () => previews?.start(),
    bridge: () => (kernel() && previews?.bridge.held() ? previews.bridge : null),
    handlers: serveRequests({
      previews: () => previews,
      here: () => Boolean(kernel()),
      on: () => toggle.on(),
      live,
    }),
  };
}

export { serveHubBase };
