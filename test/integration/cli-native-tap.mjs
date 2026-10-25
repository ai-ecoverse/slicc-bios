import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

export function origins(value) {
  if (typeof value === 'string')
    return value.replace(/https?:\/\/[^\s"'<>\\]+/g, (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return '[url]';
      }
    });
  if (Array.isArray(value)) return value.map(origins);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, origins(value)]));
  return value;
}

function metadata(message, method) {
  const params = message.params ?? {};
  const result = message.result ?? {};
  const target = params.targetInfo ?? result.targetInfo;
  const frame = params.frame;
  return {
    id: message.id,
    method: message.method ?? method,
    sessionId: message.sessionId,
    error: message.error && { code: message.error.code, message: origins(message.error.message) },
    params: message.params && {
      sessionId: params.sessionId,
      targetId: params.targetId,
      frameId: params.frameId,
      parentFrameId: params.parentFrameId,
      waitingForDebugger: params.waitingForDebugger,
      autoAttach: params.autoAttach,
      waitForDebuggerOnStart: params.waitForDebuggerOnStart,
      filter: params.filter,
      requestId: params.requestId,
      resourceType: params.resourceType,
      requestOrigin: params.request?.url && origins(params.request.url),
      errorReason: params.errorReason,
      errorText: params.errorText,
      reason: params.reason,
      frame: frame && {
        id: frame.id,
        parentId: frame.parentId,
        origin: origins(frame.url),
        unreachableOrigin: origins(frame.unreachableUrl),
      },
      targetInfo: target && {
        targetId: target.targetId,
        type: target.type,
        origin: origins(target.url),
      },
    },
    result: message.result && { sessionId: result.sessionId },
  };
}

export async function nativeTap(port, path) {
  if (port >= 9222 && port <= 9229) throw new Error('refused host debugger port');
  const output = createWriteStream(path);
  const methods = new Set([
    'Target.attachedToTarget',
    'Target.detachedFromTarget',
    'Target.targetCreated',
    'Target.targetInfoChanged',
    'Target.attachToTarget',
    'Target.detachFromTarget',
    'Target.setAutoAttach',
    'Runtime.runIfWaitingForDebugger',
    'Fetch.enable',
    'Fetch.disable',
    'Fetch.requestPaused',
    'Fetch.failRequest',
    'Fetch.continueRequest',
    'Page.frameAttached',
    'Page.frameDetached',
    'Page.frameNavigated',
    'Network.loadingFailed',
  ]);
  const clients = new Set();
  let listening;
  const server = createServer(async (req, res) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${req.url}`);
      const contentType = response.headers.get('content-type') ?? '';
      let body = Buffer.from(await response.arrayBuffer());
      if (contentType.includes('json')) {
        const value = JSON.parse(body.toString());
        const redirect = (value) => {
          if (typeof value === 'string')
            return value
              .replace(`ws://127.0.0.1:${port}/`, `ws://127.0.0.1:${listening}/`)
              .replace(`ws://localhost:${port}/`, `ws://127.0.0.1:${listening}/`);
          if (Array.isArray(value)) return value.map(redirect);
          if (value && typeof value === 'object')
            return Object.fromEntries(
              Object.entries(value).map(([key, value]) => [key, redirect(value)])
            );
          return value;
        };
        body = Buffer.from(JSON.stringify(redirect(value)));
      }
      res.writeHead(response.status, { 'content-type': contentType });
      res.end(body);
    } catch (error) {
      res.writeHead(502);
      res.end(String(error));
    }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (client, req) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${port}${req.url}`);
    clients.add(client);
    clients.add(upstream);
    const queue = [];
    const pending = new Map();
    const record = (direction, data) => {
      try {
        const message = JSON.parse(data.toString());
        const method = message.method ?? pending.get(message.id);
        if (direction === 'cli-to-chrome' && message.method && methods.has(message.method))
          pending.set(message.id, message.method);
        if (direction === 'chrome-to-cli' && message.id !== undefined) pending.delete(message.id);
        if (methods.has(method))
          output.write(
            `${JSON.stringify({ time: performance.now(), direction, ...metadata(message, method) })}\n`
          );
      } catch {}
    };
    client.on('message', (data, binary) => {
      record('cli-to-chrome', data);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else queue.push([data, binary]);
    });
    upstream.on('open', () => {
      for (const [data, binary] of queue) upstream.send(data, { binary });
      queue.length = 0;
    });
    upstream.on('message', (data, binary) => {
      record('chrome-to-cli', data);
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    for (const [socket, peer] of [
      [client, upstream],
      [upstream, client],
    ]) {
      socket.on('close', () => {
        clients.delete(socket);
        peer.terminate();
      });
      socket.on('error', () => peer.terminate());
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  listening = server.address().port;
  return {
    port: listening,
    async close() {
      for (const client of clients) client.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      output.end();
      await once(output, 'finish');
    },
  };
}
