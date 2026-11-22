import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const WINDOW = 1024 * 1024;
const CHUNK = 64 * 1024;
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
const LABEL = /^([0-9a-f]{20}-[0-9a-f]{32})\.localhost(?::\d+)?$/;
const hex = (bytes) => randomBytes(bytes).toString('hex');

let bootstrapJs;
const bootstrap = () =>
  (bootstrapJs ??= readFileSync(
    createRequire(import.meta.url).resolve('@ai-ecoverse/cherry/preview-bridge.js')
  ));

function frame(id, bytes) {
  const out = Buffer.alloc(bytes.length + 4);
  out.writeUInt32BE(id, 0);
  bytes.copy(out, 4);
  return out;
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

async function raw(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(response, status, value) {
  response
    .writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify(value));
}

const fail = (response, status, code, error) => json(response, status, { error, code });

function bridges(hub) {
  const tabs = new Map();
  hub.tabs = tabs;
  hub.states = [];
  hub.emits = [];
  const forget = (connId, reason) => {
    const tab = tabs.get(connId);
    if (!tab) return;
    tabs.delete(connId);
    hub.tell(tab.record.hostId, {
      type: 'bridge.disconnected',
      previewToken: tab.record.previewToken,
      connId,
      ...(reason ? { reason } : {}),
    });
  };
  hub.bridged = (record) => [...tabs.values()].filter((tab) => tab.record === record);
  hub.closePreviewTabs = (record) => {
    for (const tab of hub.bridged(record)) {
      tabs.delete(tab.connId);
      tab.socket.close(1000, 'preview revoked');
    }
  };
  hub.replay = (hostId) => {
    for (const record of hub.previews.values())
      if (record.hostId === hostId && record.bridge)
        hub.tell(hostId, {
          type: 'preview.state',
          previewToken: record.previewToken,
          quiet: record.quiet,
          announced: record.announced === true,
        });
    for (const tab of tabs.values())
      if (tab.record.hostId === hostId)
        hub.tell(hostId, { type: 'bridge.connected', ...tab.meta, replay: true });
  };
  hub.emitFrom = (connId, name, detail, extra = {}) => {
    const tab = tabs.get(connId);
    hub.tell(tab?.record.hostId ?? extra.hostId, {
      type: 'bridge.emit',
      previewToken: tab?.record.previewToken ?? extra.previewToken,
      connId,
      name,
      detail,
      at: new Date().toISOString(),
      ...extra,
    });
  };
  return {
    script: (record, host) =>
      `<script src="/__slicc/preview-bridge.js" data-slicc-token="${record.previewToken}" data-slicc-ws="ws://${host}/__slicc/bridge"></script>`,
    open(socket, record, request) {
      if (!record?.bridge) return socket.close(1008, 'Bridge not enabled');
      if (hub.bridged(record).length >= record.maxTabs)
        return socket.close(1008, 'Too many bridged tabs');
      const connId = randomUUID();
      const meta = {
        connId,
        previewToken: record.previewToken,
        origin: request.headers.origin ?? '',
        userAgent: request.headers['user-agent'] ?? '',
        connectedAt: new Date().toISOString(),
      };
      tabs.set(connId, { connId, record, socket, meta, seen: [] });
      socket.on('message', (data) => {
        let message;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (message.t === 'ping') return socket.send(JSON.stringify({ t: 'pong' }));
        if (message.t === 'cdp.res')
          hub.tell(record.hostId, {
            type: 'bridge.cdp.response',
            connId,
            id: message.id,
            result: message.result,
            error: message.error,
          });
        else if (message.t === 'emit') hub.emitFrom(connId, message.name, message.detail);
      });
      socket.on('close', () => forget(connId));
      socket.send(JSON.stringify({ t: 'welcome', connId }));
      hub.tell(record.hostId, { type: 'bridge.connected', ...meta });
    },
    fromPublisher(message) {
      const tab = tabs.get(message.connId);
      if (message.type === 'preview.state.update') {
        hub.states.push(message);
        const record = hub.previews.get(message.previewToken);
        if (record) record.announced = message.announced === true;
      }
      if (message.type === 'bridge.close') {
        forget(message.connId);
        tab?.socket.close(1000, 'closed by publisher');
      }
      if (message.type !== 'bridge.cdp.request') return;
      if (!tab)
        return hub.tell(hub.current?.hostId, {
          type: 'bridge.cdp.response',
          connId: message.connId,
          id: message.id,
          error: { code: -32000, message: 'Preview bridge connection is gone' },
        });
      tab.seen.push(message.method);
      tab.socket.send(
        JSON.stringify({
          t: 'cdp.req',
          id: message.id,
          method: message.method,
          params: message.params,
          sessionId: message.sessionId,
        })
      );
    },
  };
}

function streams(hub) {
  const open = new Map();
  let next = 0;
  hub.streams = open;
  hub.requests = [];
  hub.maxUnacked = 0;
  hub.inject = (token, fields = {}, frames = []) =>
    new Promise((resolve) => {
      const record = hub.previews.get(token);
      const hostId = record?.hostId ?? hub.current?.hostId;
      const socket = hub.sockets.get(hostId);
      next += 1;
      const id = next;
      const chunks = [];
      const response = {
        headersSent: false,
        writeHead(status, flat = []) {
          Object.assign(this, { status, flat, headersSent: true });
          return this;
        },
        write(part, done) {
          chunks.push(Buffer.from(part));
          done?.();
        },
        end(text) {
          if (text) chunks.push(Buffer.from(text));
          resolve({ status: this.status, flat: this.flat, body: Buffer.concat(chunks) });
        },
        destroy() {
          resolve({ status: this.status, cancelled: true, body: Buffer.concat(chunks) });
        },
      };
      open.set(id, { id, record: { hostId }, response, acked: 0, sent: 0 });
      socket.send(
        JSON.stringify({
          type: 'http.request',
          id,
          previewToken: token,
          method: 'GET',
          url: record?.url ?? `http://${token}.localhost:${hub.port}/`,
          path: '/',
          headers: [],
          body: frames.length > 0,
          ...fields,
        })
      );
      for (const piece of frames) socket.send(frame(id, Buffer.from(piece)));
      if (frames.length) socket.send(JSON.stringify({ type: 'http.request.end', id }));
    });
  return {
    relay(record, request, response, script) {
      const bridged = Boolean(script);
      const socket = hub.sockets.get(record.hostId);
      if (!socket) return response.writeHead(502).end('the publisher of this preview is offline');
      next += 1;
      const id = next;
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i].toLowerCase();
        if (HOP.has(name) || name.startsWith('x-forwarded-')) continue;
        headers.push([
          name,
          bridged && name === 'accept-encoding' ? 'identity' : request.rawHeaders[i + 1],
        ]);
      }
      const body =
        request.headers['content-length'] !== undefined
          ? Number(request.headers['content-length']) > 0
          : request.headers['transfer-encoding'] !== undefined;
      const stream = { id, record, response, bridged, script, acked: 0, sent: 0, waiting: null };
      open.set(id, stream);
      const message = {
        type: 'http.request',
        id,
        previewToken: record.previewToken,
        method: request.method,
        url: url.href,
        path: request.url,
        headers,
        body,
      };
      hub.requests.push(message);
      socket.send(JSON.stringify(message));
      response.on('close', () => {
        if (!open.has(id)) return;
        open.delete(id);
        socket.send(JSON.stringify({ type: 'http.cancel', id, reason: 'the visitor went away' }));
      });
      if (!body) return;
      (async () => {
        for await (const chunk of request) {
          for (let at = 0; at < chunk.length; at += CHUNK) {
            const part = chunk.subarray(at, at + CHUNK);
            while (stream.sent - stream.acked + part.length > WINDOW)
              await new Promise((resolve) => {
                stream.waiting = resolve;
              });
            socket.send(frame(id, part));
            stream.sent += part.length;
          }
        }
        socket.send(JSON.stringify({ type: 'http.request.end', id }));
      })().catch(() => undefined);
    },
    message(socket, message) {
      const stream = open.get(message.id);
      if (!stream) return;
      if (message.type === 'http.ack') {
        stream.acked += message.bytes;
        stream.waiting?.();
        return;
      }
      if (message.type === 'http.cancel') {
        open.delete(message.id);
        hub.cancels.push(message);
        if (!stream.response.headersSent) stream.response.writeHead(502).end(message.reason);
        else stream.response.destroy();
        return;
      }
      if (message.type === 'http.response') {
        const lower = message.headers.map(([name, value]) => [name.toLowerCase(), value]);
        const html =
          stream.bridged &&
          message.status === 200 &&
          lower.some(([name, value]) => name === 'content-type' && /^text\/html/i.test(value)) &&
          !lower.some(([name]) => name === 'content-encoding');
        stream.inject = html;
        const kept = lower.filter(
          ([name]) => !HOP.has(name) && !(html && name === 'content-length')
        );
        stream.response.writeHead(message.status, kept.flat());
        if (!message.body) {
          open.delete(message.id);
          stream.response.end();
        }
        return;
      }
      if (message.type === 'http.response.end') {
        open.delete(message.id);
        stream.response.end();
      }
    },
    body(socket, data) {
      const id = data.readUInt32BE(0);
      const stream = open.get(id);
      if (!stream) return;
      let part = data.subarray(4);
      if (stream.inject && !stream.injected) {
        stream.injected = true;
        const text = part.toString('utf8');
        const script = stream.script;
        const at = text.search(/<head[^>]*>/i);
        part = Buffer.from(
          at >= 0 ? text.replace(/<head[^>]*>/i, (head) => `${head}${script}`) : `${script}${text}`
        );
      }
      const size = data.length - 4;
      stream.unacked = (stream.unacked ?? 0) + size;
      hub.maxUnacked = Math.max(hub.maxUnacked, stream.unacked);
      stream.response.write(part, () => {
        stream.unacked -= size;
        socket.send(JSON.stringify({ type: 'http.ack', id, bytes: size }));
      });
    },
    closeAll(hostId) {
      for (const [id, stream] of [...open])
        if (stream.record.hostId === hostId) {
          open.delete(id);
          if (!stream.response.headersSent) stream.response.writeHead(502).end('publisher gone');
          else stream.response.destroy();
        }
    },
  };
}

function records(hub) {
  const previews = new Map();
  hub.previews = previews;
  hub.mints = [];
  hub.stops = [];
  hub.uploads = [];
  const stop = (record) => {
    previews.delete(record.previewToken);
    hub.closePreviewTabs(record);
    hub.tell(record.hostId, { type: 'preview.revoked', previewToken: record.previewToken });
  };
  hub.revoke = (token) => {
    const record = previews.get(token);
    if (record) stop(record);
  };
  const shown = (record) => ({
    previewToken: record.previewToken,
    url: record.url,
    entry: record.entry,
    tag: record.tag,
    mode: record.mode,
    state: record.state,
    bridge: record.bridge,
    maxTabs: record.maxTabs,
    quiet: record.quiet,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    files: record.files.size,
    bytes: [...record.files.values()].reduce((sum, file) => sum + file.bytes.length, 0),
  });
  hub.addPreview = (hostId, body) => {
    const previewToken = `${hostId}-${hex(16)}`;
    const entry = body.entry ?? '/';
    const record = {
      previewToken,
      hostId,
      url: `http://${previewToken}.localhost:${hub.port}${entry}`,
      entry,
      tag: body.tag ?? '',
      mode: body.ttlMs ? 'snapshot' : 'live',
      state: body.ttlMs ? 'uploading' : 'ready',
      bridge: body.bridge === true,
      maxTabs: body.maxTabs ?? 20,
      quiet: body.quiet === true,
      ttlMs: body.ttlMs ?? null,
      createdAt: Date.now(),
      expiresAt: null,
      files: new Map(),
    };
    previews.set(previewToken, record);
    return record;
  };
  const finalize = (record) => {
    record.state = 'ready';
    record.expiresAt = Date.now() + record.ttlMs;
    return shown(record);
  };
  return async (request, response, host, tail) => {
    if (tail === '/previews' && request.method === 'GET')
      return json(response, 200, {
        previews: [...previews.values()].filter((r) => r.hostId === host.hostId).map(shown),
      });
    if (tail === '/previews' && request.method === 'POST') {
      const body = JSON.parse((await raw(request)).toString() || '{}');
      hub.mints.push(body);
      if (hub.mintFails) return json(response, ...hub.mintFails);
      return json(response, 201, shown(hub.addPreview(host.hostId, body)));
    }
    const route = /^\/previews\/([^/]+)(?:\/(finalize|files\/(.+)))?$/.exec(tail);
    const record = route && previews.get(decodeURIComponent(route[1]));
    if (!record || record.hostId !== host.hostId) {
      await raw(request);
      return fail(response, 404, 'PREVIEW_NOT_FOUND', 'no such preview');
    }
    if (!route[2] && request.method === 'DELETE') {
      if (hub.stopFails) return json(response, ...hub.stopFails);
      hub.stops.push(record.previewToken);
      stop(record);
      return json(response, 200, { stopped: true });
    }
    if (route[2] === 'finalize' && request.method === 'POST') {
      if (record.state !== 'uploading')
        return fail(response, 409, 'SNAPSHOT_FINALIZED', 'already finalized');
      const entry = decodeURIComponent(record.entry.split('?')[0].slice(1));
      const wanted = entry === '' || entry.endsWith('/') ? `${entry}index.html` : entry;
      if (!record.files.has(wanted)) return fail(response, 400, 'ENTRY_MISSING', 'no entry file');
      if (hub.holdFinalize) await hub.holdFinalize(record);
      return json(response, 200, finalize(record));
    }
    if (route[3] && request.method === 'PUT') {
      if (request.headers['content-length'] === undefined)
        return fail(response, 411, 'LENGTH_REQUIRED', 'no Content-Length');
      const bytes = await raw(request);
      const path = route[3].split('/').map(decodeURIComponent).join('/');
      const refused = hub.uploadFails?.(path);
      if (refused) return json(response, ...refused);
      hub.uploads.push({
        path,
        type: request.headers['content-type'],
        authorization: request.headers.authorization,
      });
      record.files.set(path, { bytes, type: request.headers['content-type'] });
      return json(response, 200, { path, size: bytes.length });
    }
    return fail(response, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  };
}

function snapshotFile(record, url, response) {
  const path = decodeURIComponent(url.pathname).slice(1);
  const file = record.files.get(path === '' || path.endsWith('/') ? `${path}index.html` : path);
  if (record.state !== 'ready' || !file) return response.writeHead(404).end('not found');
  response.writeHead(200, { 'content-type': file.type }).end(file.bytes);
}

export function startServeHub() {
  const hub = {
    hosts: new Map(),
    deleted: new Set(),
    sockets: new Map(),
    fromPublisher: [],
    waiters: [],
    cancels: [],
    created: 0,
  };
  hub.tell = (hostId, message) => hub.sockets.get(hostId)?.send(JSON.stringify(message));
  const bridged = bridges(hub);
  const http = streams(hub);
  const api = records(hub);
  const visit = (request, response, record) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (record.bridge && url.pathname === '/__slicc/preview-bridge.js')
      return response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(bootstrap());
    if (record.mode === 'snapshot') return snapshotFile(record, url, response);
    http.relay(
      record,
      request,
      response,
      record.bridge ? bridged.script(record, request.headers.host) : null
    );
  };
  const server = createServer(async (request, response) => {
    const label = LABEL.exec(request.headers.host ?? '')?.[1];
    if (label) {
      const record = hub.previews.get(label);
      if (!record) return response.writeHead(404).end('no such preview');
      return visit(request, response, record);
    }
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
    const url = new URL(request.url, hub.url);
    if (url.pathname === '/api/serve/host' && request.method === 'POST') {
      hub.created += 1;
      const host = { hostId: hex(10), secret: hex(32) };
      hub.hosts.set(host.hostId, host);
      return json(response, 201, host);
    }
    const route = /^\/api\/serve\/host\/([0-9a-f]{20})(\/.*)?$/.exec(url.pathname);
    if (!route) return fail(response, 404, 'NOT_FOUND', 'not found');
    if (hub.deleted.has(route[1])) return fail(response, 410, 'HOST_GONE', 'host deleted');
    const host = hub.hosts.get(route[1]);
    if (!host) return fail(response, 404, 'HOST_NOT_FOUND', 'no such host');
    if (request.headers.authorization !== `Bearer ${host.secret}`)
      return fail(response, 401, 'UNAUTHORIZED', 'bad secret');
    return api(request, response, host, route[2] ?? '');
  });
  const sockets = new WebSocketServer({
    server,
    handleProtocols: (protocols) => (protocols.has('slicc-serve.v1') ? 'slicc-serve.v1' : false),
  });
  sockets.on('connection', (socket, request) => {
    const label = LABEL.exec(request.headers.host ?? '')?.[1];
    if (label) return bridged.open(socket, hub.previews.get(label), request);
    const route = /^\/api\/serve\/host\/([0-9a-f]{20})\/ws$/.exec(request.url);
    const host = route && hub.hosts.get(route[1]);
    const offered = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    if (!host || !offered.includes(`bearer.${host.secret}`) || hub.deleted.has(host.hostId))
      return socket.close(1008, 'refused');
    hub.sockets.get(host.hostId)?.close(4000, 'replaced');
    hub.sockets.set(host.hostId, socket);
    hub.current = host;
    socket.on('message', (data, binary) => {
      if (binary) return http.body(socket, data);
      const text = data.toString();
      if (text === 'ping') return socket.send('pong');
      const message = JSON.parse(text);
      if (message.type?.startsWith('http.')) http.message(socket, message);
      else bridged.fromPublisher(message);
      hub.fromPublisher.push(message);
      for (const wake of hub.waiters.splice(0)) wake();
    });
    socket.on('close', () => {
      if (hub.sockets.get(host.hostId) !== socket) return;
      hub.sockets.delete(host.hostId);
      http.closeAll(host.hostId);
    });
    socket.send(JSON.stringify({ type: 'hello', hostId: host.hostId }));
    hub.replay(host.hostId);
  });
  hub.deleteHost = (hostId) => {
    hub.deleted.add(hostId);
    for (const record of [...hub.previews.values()])
      if (record.hostId === hostId) hub.previews.delete(record.previewToken);
    hub.sockets.get(hostId)?.close(4001, 'host deleted');
  };
  hub.next = async (type) => {
    for (;;) {
      const found = hub.fromPublisher.findIndex((m) => m.type === type);
      if (found >= 0) return hub.fromPublisher.splice(found, 1)[0];
      await new Promise((resolve) => hub.waiters.push(resolve));
    }
  };
  hub.visit = (token, path = '/', { method = 'GET', headers = {}, body, pauseMs = 0 } = {}) =>
    new Promise((resolve, reject) => {
      const sent = httpRequest(
        {
          host: '127.0.0.1',
          port: hub.port,
          agent: false,
          method,
          path,
          headers: { ...headers, host: `${token}.localhost:${hub.port}` },
        },
        async (response) => {
          if (pauseMs) {
            response.pause();
            await new Promise((wake) => setTimeout(wake, pauseMs));
          }
          const bytes = await raw(response).catch(() => null);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: bytes ?? Buffer.alloc(0),
            broken: bytes === null || !response.complete,
          });
        }
      );
      sent.on('error', reject);
      sent.end(body);
    });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      hub.port = server.address().port;
      hub.url = `http://127.0.0.1:${hub.port}`;
      hub.close = () => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        server.closeAllConnections?.();
        server.close();
      };
      resolve(hub);
    })
  );
}
