import { asker, refused, who } from './requests.js';
import { createSnapshots, snapshotOptions, snapshotPrompt, snapshotStore } from './snapshot.js';

export const SERVED_PREFIX = '/srv/serve/';
export const CHUNK = 64 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_RANGE_BYTES = 8 * 1024 * 1024;
export const REASON_BYTES = 4096;
export const FETCH_MS = 25_000;
export const HOPS = 5;
export const PREVIEWS_SWITCH = { key: 'previews', label: 'Public previews' };
export const PREVIEWS_OFF = "public previews are off in seven's settings";
export const SERVING = 'Serving publicly';
export const STOPPED = 'stopped in seven';
export const STOPPED_BY_COMMAND = 'stopped with serve --stop';
export const REVOKED = 'revoked by the tray hub';
export const SWITCHED_OFF = 'public previews were switched off';
export const LOST = 'seven lost its tray';
export const DISMISSED = 'the request to publish was dismissed';
export const LATE = 'nobody answered the request to publish within 60 s';
export const NO_TRAY = 'seven publishes previews only through its tray hub, and it has none here';
export const GONE = 'this preview is no longer served';
export const NOT_READY = 'seven isn’t connected to the tray hub yet; try again in a moment';
export const ELSEWHERE =
  "seven publishes only from the tab that runs its kernel; run serve in that tab's terminal";
export const UNKNOWN = 'the tray hub has no such preview';
export const TOO_LARGE = `preview file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MiB limit`;

const encoder = new TextEncoder();

export function withinServedRoot(vfsPath, servedRoot) {
  if (typeof vfsPath !== 'string' || typeof servedRoot !== 'string') return false;
  if (!vfsPath || !servedRoot || servedRoot === '/') return false;
  if (!vfsPath.startsWith('/') || /%2e/i.test(vfsPath)) return false;
  if (vfsPath.split('/').some((part) => part === '.' || part === '..')) return false;
  const root = servedRoot.endsWith('/') ? servedRoot.slice(0, -1) : servedRoot;
  return vfsPath === root || vfsPath.startsWith(`${root}/`);
}

export function originPath(origin, vfsPath) {
  if (origin.entryIsRoot && vfsPath === origin.entryPath) return '/';
  const root = origin.servedRoot.replace(/\/+$/, '');
  const rest = vfsPath.startsWith(root) ? vfsPath.slice(root.length) : '';
  return rest || '/';
}

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

const MIME = [
  [/\.html?$/i, 'text/html'],
  [/\.css$/i, 'text/css'],
  [/\.m?js$/i, 'application/javascript'],
  [/\.json$/i, 'application/json'],
  [/\.svg$/i, 'image/svg+xml'],
  [/\.png$/i, 'image/png'],
  [/\.jpe?g$/i, 'image/jpeg'],
  [/\.gif$/i, 'image/gif'],
  [/\.webp$/i, 'image/webp'],
  [/\.ico$/i, 'image/x-icon'],
  [/\.woff2$/i, 'font/woff2'],
  [/\.woff$/i, 'font/woff'],
  [/\.ttf$/i, 'font/ttf'],
  [/\.mp4$/i, 'video/mp4'],
  [/\.webm$/i, 'video/webm'],
  [/\.mp3$/i, 'audio/mpeg'],
  [/\.pdf$/i, 'application/pdf'],
  [/\.xml$/i, 'application/xml'],
  [/\.wasm$/i, 'application/wasm'],
  [/\.txt$/i, 'text/plain'],
];

export function mimeOf(path) {
  return MIME.find(([pattern]) => pattern.test(path))?.[1] ?? 'application/octet-stream';
}

export function base64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let out = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(out);
}

export function textPieces(text, size = CHUNK) {
  const pieces = [];
  let rest = text;
  while (rest.length > size) {
    let at = size;
    const code = rest.charCodeAt(at - 1);
    if (code >= 0xd800 && code <= 0xdbff) at -= 1;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  pieces.push(rest);
  return pieces;
}

function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function chunked(reqId, mime, bytes, text, meta) {
  const decoded = text ? utf8(bytes) : null;
  const encoding = decoded === null ? 'base64' : 'utf-8';
  const pieces = decoded === null ? textPieces(base64(bytes)) : textPieces(decoded);
  return pieces.map((content, index) => ({
    type: 'preview.response',
    reqId,
    ok: true,
    mime,
    chunkIndex: index,
    totalChunks: pieces.length,
    content,
    encoding,
    ...meta,
  }));
}

export function failed(reqId, status, reason, size) {
  return {
    type: 'preview.response',
    reqId,
    ok: false,
    status,
    ...(reason ? { reason } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

export function contentRange(header) {
  const found = /^\s*bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)\s*$/i.exec(header ?? '');
  return found ? { start: Number(found[1]), end: Number(found[2]), total: Number(found[3]) } : null;
}

export function unsatisfiedSize(header) {
  const found = /^\s*bytes\s+\*\s*\/\s*(\d+)\s*$/i.exec(header ?? '');
  return found ? Number(found[1]) : undefined;
}

export async function capped(body, cap) {
  const parts = [];
  let size = 0;
  let over = false;
  const reader = body?.getReader?.();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - size;
      if (value.byteLength > room) {
        if (room > 0) parts.push(value.subarray(0, room));
        size = cap;
        over = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      parts.push(value);
      size += value.byteLength;
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return { bytes, over };
}

export function parsed(message) {
  const text = (key) => (typeof message?.[key] === 'string' ? message[key] : null);
  const reqId = text('reqId');
  const servedRoot = text('servedRoot');
  const vfsPath = text('vfsPath');
  if (reqId === null || servedRoot === null || vfsPath === null) return null;
  return { reqId, servedRoot, vfsPath, asText: message.asText === true, range: text('range') };
}

const REDIRECTS = [301, 302, 303, 307, 308];

function deadline(timers, ms, controller) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      const error = new Error(`no answer in ${ms / 1000} s`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return { expired, clear: () => timers.clearTimeout(timer) };
}

export async function originFetch(fetcher, port, path, range, signal) {
  const same = new Set([`${port}.kernel.localhost`, `127.0.0.1:${port}`, `localhost:${port}`]);
  let target = new URL(path, `http://${port}.kernel.localhost`);
  for (let hops = 0; ; hops += 1) {
    const headers = { 'accept-encoding': 'identity', ...(range ? { range } : {}) };
    const response = await fetcher(
      new Request(target, { method: 'GET', headers, redirect: 'manual', signal }),
      port
    );
    const location = REDIRECTS.includes(response.status) && response.headers.get('location');
    const next =
      location && hops < HOPS && URL.canParse(location, target) && new URL(location, target);
    if (next?.protocol !== 'http:' || !same.has(next.host)) return response;
    await response.body?.cancel().catch(() => undefined);
    target = new URL(`${next.pathname}${next.search}`, `http://${port}.kernel.localhost`);
  }
}

async function answered(request, origin, response) {
  const { reqId } = request;
  const path = originPath(origin, request.vfsPath);
  const status = response.status;
  const mime = response.headers.get('content-type') || mimeOf(path);
  if (status === 200) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return [failed(reqId, 413, TOO_LARGE, declared)];
    }
    const { bytes, over } = await capped(response.body, MAX_FILE_BYTES + 1);
    if (over || bytes.byteLength > MAX_FILE_BYTES) return [failed(reqId, 413, TOO_LARGE)];
    return chunked(reqId, mime, bytes, request.asText, { status: 200, size: bytes.byteLength });
  }
  if (status === 206) {
    const range = contentRange(response.headers.get('content-range'));
    if (!range) {
      await response.body?.cancel().catch(() => undefined);
      return [failed(reqId, 502, 'a 206 without Content-Range')];
    }
    const { bytes } = await capped(response.body, MAX_RANGE_BYTES);
    if (!bytes.byteLength) return [failed(reqId, 416, null, range.total)];
    const end = range.start + bytes.byteLength - 1;
    return chunked(reqId, mime, bytes, false, {
      status: 206,
      size: range.total,
      range: { start: range.start, end },
    });
  }
  if (status === 416) {
    await response.body?.cancel().catch(() => undefined);
    return [failed(reqId, 416, null, unsatisfiedSize(response.headers.get('content-range')))];
  }
  const { bytes } = await capped(response.body, REASON_BYTES);
  const text = new TextDecoder().decode(bytes).trim();
  return [failed(reqId, status, text || `the server answered ${status}`)];
}

export async function relay(
  message,
  { origin, fetch: fetcher, timers = globalThis, ms = FETCH_MS }
) {
  const request = parsed(message);
  if (!request) return [];
  const { reqId } = request;
  if (!withinServedRoot(request.vfsPath, request.servedRoot)) return [failed(reqId, 403)];
  const found = origin(request.servedRoot);
  if (!found) return [failed(reqId, 404, GONE)];
  const path = originPath(found, request.vfsPath);
  const controller = new AbortController();
  const limit = deadline(timers, ms, controller);
  try {
    return await Promise.race([
      (async () => {
        let response;
        try {
          response = await originFetch(fetcher, found.port, path, request.range, controller.signal);
        } catch (error) {
          return [
            failed(reqId, 502, `nothing answers on kernel port ${found.port}: ${error.message}`),
          ];
        }
        try {
          return await answered(request, found, response);
        } catch (error) {
          return [failed(reqId, 502, error.message)];
        }
      })(),
      limit.expired.catch((error) => [
        failed(reqId, 504, `kernel port ${found.port}: ${error.message}`),
      ]),
    ]);
  } finally {
    limit.clear();
  }
}

export function serveId(random = () => crypto.getRandomValues(new Uint8Array(16))) {
  return [...random()].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createPreviews({
  tray,
  fetch: fetcher,
  timers = globalThis,
  id = serveId,
  now = Date.now,
  warn = (message) => console.warn(message),
  store = snapshotStore({ now }),
}) {
  const entries = new Map();
  const snapshots = createSnapshots({
    tray,
    refusal: hubRefusal,
    store,
    id,
    now,
    warn,
    prefix: SERVED_PREFIX,
    publicUrl,
    ready: () => {
      if (!tray) throw new DOMException(NO_TRAY, 'NotSupportedError');
      if (!tray.previews.ready()) throw new Error(NOT_READY);
    },
  });
  const byRoot = (servedRoot) =>
    [...entries.values()].find((entry) => entry.servedRoot === servedRoot) ?? null;
  const visible = (entry, uid) => uid === 0 || entry.uid === uid;
  const byToken = (token) =>
    [...entries.values()].find((entry) => entry.previewToken === token) ?? null;

  async function revoke(token) {
    const stopped = await tray.previews.stop(token);
    if (!stopped.ok && stopped.status !== 404)
      throw new Error(stopped.value?.error ?? `the tray hub answered ${stopped.status}`);
    return stopped.value?.revoked !== false;
  }

  function end(entry, reason, hub) {
    if (entries.get(entry.id) !== entry) return false;
    entries.delete(entry.id);
    for (const listener of [...entry.listeners]) listener(reason);
    if (hub && entry.previewToken)
      revoke(entry.previewToken).catch((error) =>
        warn(`serve: revoking the preview of ${entry.servedRoot}: ${error.message}`)
      );
    return true;
  }

  async function publish({ port, root = '', entry = null, allowLive = true, stamp = null }) {
    if (!tray) throw new DOMException(NO_TRAY, 'NotSupportedError');
    if (!tray.previews.ready()) throw new Error(NOT_READY);
    const trayId = tray.previews.trayId();
    const name = id();
    const servedRoot = `${SERVED_PREFIX}${name}`;
    const item = {
      id: name,
      port,
      root,
      entry,
      servedRoot,
      entryPath: `${servedRoot}/${entry ?? 'index.html'}`,
      entryIsRoot: entry === null,
      stamp,
      uid: stamp?.uid ?? null,
      trayId,
      since: now(),
      previewToken: null,
      url: null,
      listeners: new Set(),
    };
    entries.set(name, item);
    let minted;
    try {
      minted = await tray.previews.mint({
        servedRoot,
        entryPath: item.entryPath,
        allowLive,
      });
    } catch (error) {
      entries.delete(name);
      throw error;
    }
    const answer = hubRefusal(minted);
    if (answer) {
      entries.delete(name);
      return { refused: answer };
    }
    const { previewToken, url } = minted.value ?? {};
    if (typeof previewToken !== 'string' || typeof url !== 'string') {
      entries.delete(name);
      throw new Error("the tray hub's mint answer has no previewToken or url");
    }
    item.previewToken = previewToken;
    item.url = publicUrl(url, entry !== null);
    if (entries.get(name) !== item) {
      await revoke(previewToken).catch(() => undefined);
      throw new DOMException(STOPPED, 'AbortError');
    }
    return {
      id: name,
      url: item.url,
      previewToken,
      trayId,
      on(listener) {
        item.listeners.add(listener);
        return () => item.listeners.delete(listener);
      },
      stop: (reason = STOPPED) => end(item, reason, true),
    };
  }

  async function sweep() {
    const listed = await tray.previews.list();
    if (!listed.ok) return;
    const served = new Set([...entries.values()].map((entry) => entry.servedRoot));
    const orphans = (Array.isArray(listed.value?.previews) ? listed.value.previews : []).filter(
      (preview) =>
        typeof preview?.previewToken === 'string' &&
        (preview.mode ?? 'live') !== 'persistent' &&
        typeof preview.servedRoot === 'string' &&
        preview.servedRoot.startsWith(SERVED_PREFIX) &&
        !served.has(preview.servedRoot)
    );
    for (const preview of orphans)
      await revoke(preview.previewToken).catch((error) =>
        warn(`serve: revoking the preview of ${preview.servedRoot}: ${error.message}`)
      );
  }

  return {
    publish,
    snapshot: snapshots.snapshot,
    list: (uid = 0) => [
      ...[...entries.values()]
        .filter((entry) => entry.previewToken && visible(entry, uid))
        .map((entry) => ({
          previewToken: entry.previewToken,
          url: entry.url,
          ...(entry.root ? { root: entry.root } : {}),
          port: entry.port,
          ...(entry.entry ? { entry: entry.entry } : {}),
          since: entry.since,
        })),
      ...snapshots.list(uid),
    ],
    async stop(token, uid = 0) {
      const entry = byToken(token);
      const kept = entry ? false : snapshots.held(token, uid);
      if ((entry && !visible(entry, uid)) || kept === null)
        throw new DOMException(UNKNOWN, 'NotFoundError');
      if (entry) end(entry, STOPPED_BY_COMMAND, false);
      const revoked = await revoke(token);
      if (kept) snapshots.revoked(token);
      if (!revoked && !entry && !kept) throw new DOMException(UNKNOWN, 'NotFoundError');
    },
    stopAll(reason) {
      for (const entry of [...entries.values()]) end(entry, reason, true);
    },
    control: {
      async request(message, send) {
        const answers = await relay(message, { origin: byRoot, fetch: fetcher, timers });
        for (const answer of answers) send(answer);
      },
      revoked(message) {
        snapshots.revoked(message?.previewToken);
        const entry = byToken(message?.previewToken);
        if (entry) end(entry, REVOKED, false);
      },
      state(message) {
        const entry = byToken(message?.previewToken);
        if (entry)
          entry.state = { quiet: message.quiet === true, announced: message.announced === true };
      },
      connected: () => {
        const trayId = tray.previews.trayId();
        for (const entry of [...entries.values()])
          if (entry.previewToken && entry.trayId !== trayId) end(entry, LOST, false);
        return sweep().catch((error) =>
          warn(`serve: listing the tray's previews: ${error.message}`)
        );
      },
    },
  };
}

const LINK_LOGIN = /<([^>]+)>\s*;[^,]*\brel="?login"?/i;

export function hubRefusal(minted) {
  const headers = minted.headers ?? new Headers();
  const status = Number(headers.get('x-tray-status')) || minted.status;
  if (status >= 200 && status < 300) return null;
  const value = minted.value ?? {};
  const moved = status >= 300 && status < 400;
  const signIn =
    (typeof value.signIn === 'string' && value.signIn) ||
    LINK_LOGIN.exec(headers.get('link') ?? '')?.[1] ||
    (moved && (headers.get('x-tray-location') || headers.get('location'))) ||
    null;
  const retryAfter = headers.get('retry-after');
  return {
    error: (typeof value.error === 'string' && value.error) || `the tray hub answered ${status}`,
    status,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(signIn ? { signIn } : {}),
    ...(Number.isFinite(value.active) ? { active: value.active } : {}),
    ...(Number.isFinite(value.limit) ? { limit: value.limit } : {}),
  };
}

export function publishPrompt({ stamp, options }) {
  const root =
    typeof options?.root === 'string' && options.root
      ? options.root
      : `the server on port ${options?.port}`;
  return {
    title: `Publish ${root} at a public URL?`,
    body: `${asker(stamp)} asks seven to publish ${root} at a public URL. Anyone with the link can open it while it is served.`,
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
    if (!registry) throw new DOMException(NO_TRAY, 'NotSupportedError');
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
      enabled();
      const registry = owner();
      await gesture(stamp, publishPrompt(request), signal);
      enabled();
      const published = await registry.publish({
        port,
        root,
        entry,
        allowLive: options?.allowLive !== false,
        stamp,
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
      const finish = (reason) => {
        signal?.removeEventListener('abort', abort);
        chip?.();
        chip = null;
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
                ...(published.trayId ? { trayId: published.trayId } : {}),
              })
            );
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
      const { url, previewToken, trayId, expiresAt } = done.item;
      return `${JSON.stringify({ url, previewToken, ...(trayId ? { trayId } : {}), expiresAt, files, bytes })}\n`;
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
  };
}

export function publicPreviews({ tray, kernel, switches, live }) {
  const previews = tray
    ? createPreviews({ tray, fetch: (request, port) => kernel().loopbackFetch(request, { port }) })
    : null;
  const toggle = switches.add({ ...PREVIEWS_SWITCH, off: () => previews?.stopAll(SWITCHED_OFF) });
  return {
    control: () => (kernel() ? previews?.control : null),
    handlers: serveRequests({
      previews: () => previews,
      here: () => Boolean(kernel()),
      on: () => toggle.on(),
      live,
    }),
  };
}
