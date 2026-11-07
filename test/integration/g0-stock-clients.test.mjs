import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { boot } from './bios.mjs';
import { debuggerUrl, devtools, launch } from './chrome.mjs';
import { linkNode } from './linked-node.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const chrome = await launch({
  tools: false,
  args: ['--remote-allow-origins=*', '--host-resolver-rules=MAP frame.test 127.0.0.1'],
});
const { port } = await devtools(chrome);
const browser = await debuggerUrl(port);
after(() => chrome.close());

test('G0: what stock CDP clients need from the facade hook’s guard', {
  timeout: 150 * 60 * 1000,
}, async (t) => {
  const seven = await chrome.page(t);
  const extensionSocket = new WebSocket(browser, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    extensionSocket.once('open', resolve);
    extensionSocket.once('error', reject);
  });
  t.after(() => extensionSocket.close());
  extensionSocket.on('message', (data) => {
    void seven.evaluate((message) => window.g0cdpIn(message), data.toString()).catch(() => false);
  });
  await seven.expose('g0cdpOut', (command) => {
    if (extensionSocket.readyState === 1) extensionSocket.send(JSON.stringify(command));
  });
  await seven.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(globalThis, 'crestDevTools', { configurable: true, value: Object.freeze({ webSocketDebuggerUrl: ${JSON.stringify(browser)} }) });`,
  });
  await seven.init(() => {
    globalThis.sliccKernelDebug = true;
    const pending = new Map();
    const listeners = new Set();
    let next = 0;
    window.g0cdpIn = (text) => {
      const message = JSON.parse(text);
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
    };
    Object.defineProperty(globalThis, 'sliccExtension', {
      value: Object.freeze({
        version: '7.10.0',
        fetch: (input, init) => fetch(input, init),
        cdp: Object.freeze({
          send(method, params, sessionId) {
            next += 1;
            const id = next;
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              window.g0cdpOut(JSON.stringify({ id, method, params, sessionId }));
            });
          },
          on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        }),
      }),
    });
  });
  await boot(seven);
  const [linked] = await linkNode(t, seven, port);
  assert.ok(linked, 'a linked browser');
  const sockets = new Map();
  await seven.expose('g0out', ({ id, text, closed }) => {
    const socket = sockets.get(id);
    if (!socket) return;
    if (closed !== undefined) socket.close(1011, closed.slice(0, 120));
    else if (socket.readyState === 1) socket.send(text);
  });
  await seven.evaluate(() => {
    window.g0 = new Map();
    window.g0open = async (id, runtime) => {
      try {
        const connection = await globalThis.sliccBrowserHook({ runtime });
        connection.onmessage = (text) => window.g0out(JSON.stringify({ id, text }));
        connection.onclose = (reason) =>
          window.g0out(JSON.stringify({ id, closed: String(reason ?? '') }));
        window.g0.set(id, connection);
        return true;
      } catch (error) {
        return String(error?.message ?? error);
      }
    };
    window.g0send = (id, text) => {
      window.g0.get(id)?.send(text);
      return true;
    };
    window.g0close = (id) => {
      window.g0.get(id)?.close();
      window.g0.delete(id);
      return true;
    };
    return true;
  });
  const runtimes = { devtools: 'devtools', extension: 'extension', link: linked };
  const server = createServer((_, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({
    server,
    maxPayload: 256 * 1024 * 1024,
    perMessageDeflate: false,
  });
  let ids = 0;
  wss.on('connection', (socket, req) => {
    ids += 1;
    const id = ids;
    const runtime = runtimes[new URL(req.url, 'http://x').pathname.slice(1)];
    sockets.set(id, socket);
    let chain = seven
      .evaluate((id, runtime) => window.g0open(id, runtime), id, runtime)
      .then((opened) => {
        if (opened !== true) socket.close(1011, String(opened).slice(0, 120));
      });
    socket.on('message', (data) => {
      const text = data.toString();
      chain = chain
        .then(() => seven.evaluate((id, text) => window.g0send(id, text), id, text))
        .catch(() => {});
    });
    socket.on('close', () => {
      sockets.delete(id);
      chain = chain.then(() => seven.evaluate((id) => window.g0close(id), id)).catch(() => {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of wss.clients) socket.terminate();
    server.close();
  });
  const bridge = `ws://127.0.0.1:${server.address().port}`;
  const out = process.env.G0_OUT ?? join(here, '..', '..', 'g0-bios.json');
  await mkdir(dirname(out), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      join(here, 'g0.mjs'),
      out,
      `control=${browser}`,
      `bios-devtools=${bridge}/devtools`,
      `bios-extension=${bridge}/extension`,
      `bios-link=${bridge}/link`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, G0_FRAME_HOST: 'frame.test' } }
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const code = await new Promise((resolve) => child.on('close', resolve));
  console.log(output);
  assert.equal(code, 0, output);
});
