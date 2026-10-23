import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createServer as createTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { WebSocket, WebSocketServer } from 'ws';
import { ready } from './bios.mjs';
import { debuggerUrl, launch } from './chrome.mjs';
import { extensionOver } from './fake-extension.mjs';

const run = promisify(execFile);
const TYPES = ['fetch', 'xhr', 'img', 'script', 'stylesheet', 'iframe', 'beacon', 'eventsource'];
const HOWS = ['direct', '302', '307'];
const ORIGINS = ['seven', 'vault'];
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function debuggingPort() {
  for (let port = 9300; port <= 9309; port += 1) {
    try {
      await new Promise((resolve, reject) => {
        const probe = createTcp();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no free port in 9300-9309');
}

async function certificate() {
  const dir = await mkdtemp(join(tmpdir(), 'guard-requests-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=ordinary.test',
    '-addext',
    'subjectAltName=DNS:ordinary.test,DNS:other.test,DNS:seven.sliccy.ai,DNS:vault.sliccy.ai',
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  const pair = { key: await readFile(key), cert: await readFile(cert) };
  await rm(dir, { recursive: true, force: true });
  return pair;
}

const hits = [];
const site = createServer(await certificate(), (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const url = new URL(req.url, `https://${req.headers.host}`);
  hits.push({
    host,
    path: url.pathname,
    method: req.method,
    cookie: req.headers.cookie ?? '',
    authorization: req.headers.authorization ?? '',
  });
  const parts = url.pathname.split('/').filter(Boolean);
  const allow = (origin) => {
    res.setHeader('access-control-allow-origin', origin || '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'authorization');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('vary', 'Origin');
  };
  if (req.method === 'OPTIONS') {
    allow(req.headers.origin);
    res.writeHead(204);
    return res.end();
  }
  if (parts[0] === 'arm') {
    const tag = host.startsWith('vault.') ? 'vault' : 'seven';
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': [`lax=${tag}-lax; Path=/; SameSite=Lax`, `def=${tag}-def; Path=/`],
    });
    return res.end('<title>armed</title>');
  }
  if (host === 'ordinary.test' && parts[0] === 'bounce') {
    res.writeHead(302, {
      location: `https://ordinary.test:${site.address().port}/land${url.search}`,
    });
    return res.end();
  }
  if (host === 'ordinary.test' && parts[0] === 'go') {
    const [, how, type, origin] = parts;
    const dest = origin === 'vault' ? 'vault.sliccy.ai' : 'seven.sliccy.ai';
    res.writeHead(how === '307' ? 307 : 302, {
      location: `https://${dest}:${site.address().port}/t/${type}/${how}/${origin}`,
    });
    return res.end();
  }
  if (parts[0] === 't' && parts[1] === 'script') {
    allow(req.headers.origin);
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end('globalThis.ordinaryScript=1');
  }
  if (parts[0] === 't' && parts[1] === 'stylesheet') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end('html{background-color:rgb(1, 2, 3)}');
  }
  if (parts[0] === 't' && parts[1] === 'img') {
    res.writeHead(200, { 'content-type': 'image/gif' });
    return res.end(GIF);
  }
  if (parts[0] === 't' && parts[1] === 'eventsource') {
    allow(req.headers.origin);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    return res.end('retry: 600000\ndata: x\n\n');
  }
  if (parts[0] === 't' && parts[1] === 'iframe') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<title>frame</title>');
  }
  if (parts[0] === 'drive') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(drive);
  }
  allow(req.headers.origin);
  res.writeHead(200, { 'content-type': 'text/plain' });
  return res.end('ok');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const port = site.address().port;
after(() => site.close());

const drive = `<!doctype html><title>drive</title><body><script>
const port = ${JSON.stringify(String(port))};
const origins = {
  seven: 'https://seven.sliccy.ai:' + port,
  vault: 'https://vault.sliccy.ai:' + port,
  other: 'https://other.test:' + port,
};
const types = ${JSON.stringify(TYPES)};
const hows = ${JSON.stringify(HOWS)};
const target = (origin, type, how) => how === 'direct'
  ? origins[origin] + '/t/' + type + '/' + how + '/' + origin
  : location.origin + '/go/' + how + '/' + type + '/' + origin;
const finish = (el) => new Promise((resolve) => {
  const timer = setTimeout(resolve, 4000);
  const done = () => { clearTimeout(timer); resolve(); };
  el.addEventListener('load', done, { once: true });
  el.addEventListener('error', done, { once: true });
});
async function load(origin, type, how) {
  const url = target(origin, type, how);
  if (type === 'fetch') {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store' }).catch(() => null);
    return response && response.ok === true;
  }
  if (type === 'xhr') {
    return await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.withCredentials = true;
      xhr.onload = () => resolve(xhr.status === 200);
      xhr.onerror = () => resolve(false);
      xhr.send();
    });
  }
  if (type === 'img') {
    const img = new Image();
    const done = finish(img);
    img.src = url;
    await done;
    return img.complete && img.naturalWidth > 0;
  }
  if (type === 'script') {
    const script = document.createElement('script');
    const done = finish(script);
    script.src = url;
    document.body.append(script);
    await done;
    return globalThis.ordinaryScript === 1;
  }
  if (type === 'stylesheet') {
    const link = document.createElement('link');
    const done = finish(link);
    link.rel = 'stylesheet';
    link.href = url;
    document.head.append(link);
    await done;
    return getComputedStyle(document.documentElement).backgroundColor === 'rgb(1, 2, 3)';
  }
  if (type === 'iframe') {
    const frame = document.createElement('iframe');
    const done = finish(frame);
    frame.src = url;
    document.body.append(frame);
    await done;
    return true;
  }
  if (type === 'beacon') return navigator.sendBeacon(url, 'x');
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; source.close(); resolve(); };
    const source = new EventSource(url, { withCredentials: true });
    const timer = setTimeout(done, 4000);
    source.onopen = () => { clearTimeout(timer); done(); };
    source.onerror = () => { clearTimeout(timer); done(); };
  });
  return true;
}
(async () => {
  const ordinary = {};
  for (const type of types) ordinary[type] = await load('other', type, 'direct');
  const protectedLoads = [];
  for (const origin of ['seven', 'vault']) {
    for (const type of types) {
      for (const how of hows) protectedLoads.push(load(origin, type, how));
    }
  }
  await Promise.all(protectedLoads);
  await new Promise((resolve) => setTimeout(resolve, 300));
  document.body.dataset.report = JSON.stringify(ordinary);
  document.title = types.every((type) => ordinary[type]) ? 'DROVE' : 'PARTIAL';
})();
</script>`;

const debugging = await debuggingPort();
const chrome = await launch({
  args: [
    `--remote-debugging-port=${debugging}`,
    '--remote-allow-origins=*',
    '--ignore-certificate-errors',
    `--host-resolver-rules=MAP seven.sliccy.ai 127.0.0.1, MAP vault.sliccy.ai 127.0.0.1, MAP ordinary.test 127.0.0.1, MAP other.test 127.0.0.1`,
  ],
});
after(() => chrome.close());
const browser = await debuggerUrl(debugging);
const fakeExtension = extensionOver(browser);
const version = await fetch(`http://127.0.0.1:${debugging}/json/version`).then((response) =>
  response.json()
);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms, label) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await pause(100);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

for (const origin of ORIGINS) {
  const host = origin === 'vault' ? 'vault.sliccy.ai' : 'seven.sliccy.ai';
  const url = `https://${host}:${port}/arm`;
  const before = hits.length;
  const created = await chrome.cdp.send('Target.createTarget', { url });
  await until(
    () => hits.slice(before).some((hit) => hit.host === host && hit.path === '/arm'),
    15000,
    url
  );
  await pause(200);
  await chrome.cdp.send('Target.closeTarget', { targetId: created.targetId });
}
hits.length = 0;

function bridge(upstream) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (client) => {
    const socket = new WebSocket(upstream);
    const pending = [];
    const send = (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
      else pending.push(data);
    };
    socket.on('open', () => {
      for (const data of pending.splice(0)) socket.send(data);
    });
    socket.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on('message', (data, isBinary) => send(isBinary ? data : data.toString()));
    const shut = () => {
      client.close();
      socket.close();
    };
    socket.on('close', shut);
    client.on('close', () => socket.close());
    socket.on('error', shut);
    client.on('error', shut);
  });
  return new Promise((resolve) => {
    wss.on('listening', () =>
      resolve({
        url: `ws://127.0.0.1:${wss.address().port}`,
        close: () => wss.close(),
      })
    );
  });
}

function fakeNode(devtools) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frame = (type, id, payload = new Uint8Array(0)) => {
    const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
    const out = new Uint8Array(5 + bytes.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, id);
    out.set(bytes, 5);
    return out;
  };
  const pc = new RTCPeerConnection();
  const answer = (channel, id, meta) => {
    if (meta.kind !== 'cdp') {
      channel.send(frame(2, id, '{}'));
      return () => {};
    }
    const ws = new WebSocket(devtools);
    const pending = [];
    let unacked = 0;
    const pump = () => {
      while (pending.length && unacked + pending[0].length <= 65536) {
        const piece = pending.shift();
        unacked += piece.length;
        channel.send(frame(3, id, piece));
      }
    };
    const sendText = (text) => {
      const body = encoder.encode(text);
      const framed = new Uint8Array(4 + body.length);
      new DataView(framed.buffer).setUint32(0, body.length);
      framed.set(body, 4);
      for (let at = 0; at < framed.length; at += 16384) pending.push(framed.slice(at, at + 16384));
      pump();
    };
    ws.onopen = () => channel.send(frame(2, id, '{}'));
    ws.onmessage = (event) =>
      sendText(typeof event.data === 'string' ? event.data : decoder.decode(event.data));
    let buffer = new Uint8Array(0);
    return (type, payload) => {
      const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
      if (type === 6 && bytes.length === 4) {
        unacked -= new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
        if (unacked < 0) unacked = 0;
        pump();
        return;
      }
      if (type !== 3) return;
      const credit = new Uint8Array(4);
      new DataView(credit.buffer).setUint32(0, bytes.length);
      channel.send(frame(6, id, credit));
      const merged = new Uint8Array(buffer.length + bytes.length);
      merged.set(buffer);
      merged.set(bytes, buffer.length);
      buffer = merged;
      while (buffer.length >= 4) {
        const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
        if (size > 8000000 || buffer.length < 4 + size) return;
        const text = decoder.decode(buffer.subarray(4, 4 + size));
        buffer = buffer.slice(4 + size);
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      }
    };
  };
  const serve = (channel) => {
    channel.binaryType = 'arraybuffer';
    const streams = new Map();
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        channel.send(
          JSON.stringify({
            v: 1,
            role: 'node',
            name: 'fake node',
            host: 'Fake-Node',
            mode: 'local',
            caps: ['cdp'],
            version: '1.47.3',
            routes: { prefixes: [], exit: true },
            browsers: [{ id: 'chrome', name: 'Chrome' }],
          })
        );
        return;
      }
      const bytes = new Uint8Array(data);
      const id = new DataView(bytes.buffer).getUint32(1);
      const payload = bytes.subarray(5);
      if (bytes[0] === 1) streams.set(id, answer(channel, id, JSON.parse(decoder.decode(payload))));
      else streams.get(id)?.(bytes[0], payload.slice());
    };
  };
  pc.ondatachannel = ({ channel }) => serve(channel);
  const nonce = 'guard-requests';
  pc.onicecandidate = ({ candidate }) =>
    globalThis.sliccLinkReceive(
      JSON.stringify({ t: 'candidate', nonce, candidate: candidate?.toJSON() ?? null })
    );
  globalThis.sliccLinkSend = async (text) => {
    const message = JSON.parse(text);
    if (message.nonce !== nonce) return;
    if (message.t === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      globalThis.sliccLinkReceive(
        JSON.stringify({ t: 'answer', nonce, sdp: pc.localDescription.sdp })
      );
    } else if (message.t === 'candidate' && message.candidate) {
      await pc.addIceCandidate(message.candidate).catch(() => {});
    }
  };
  globalThis.sliccLinkReceive(JSON.stringify({ t: 'hello', v: 1, nonce }));
}

async function rig({ transport, proxy, runtime, url }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { proxyHost, extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const opened =
    transport === 'link'
      ? await globalThis.sliccCdp({ runtime })
      : guardProtected(
          transport === 'proxy'
            ? await proxyHost(proxy)()
            : extensionConnection(globalThis.sliccExtension.cdp),
          self.origin
        );
  const pending = new Map();
  let next = 0;
  opened.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      const timer = setTimeout(
        () => resolve({ error: { message: `${method} got no answer` } }),
        15000
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      opened.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const created = await send('Target.createTarget', { url });
  const targetId = created.result?.targetId;
  const session = (await send('Target.attachToTarget', { targetId, flatten: true })).result
    ?.sessionId;
  if (!session) return { error: `attach: ${JSON.stringify(created)}` };
  await send('Page.enable', {}, session);
  await send('Runtime.enable', {}, session);
  const read = async () =>
    (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, session))
      .result?.result?.value ?? '';
  const deadline = Date.now() + 25000;
  let title = '';
  while (Date.now() < deadline) {
    title = await read();
    if (title === 'DROVE' || title === 'PARTIAL') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const report = await send(
    'Runtime.evaluate',
    { expression: 'document.body?.dataset.report ?? ""', returnByValue: true },
    session
  );
  await send('Target.closeTarget', { targetId });
  return { title, report: report.result?.result?.value ?? '', error: created.error?.message };
}

async function clients({ transport, proxy, runtime, port }) {
  const { guardProtected } = await import(new URL('guard.js', location.href).href);
  const { proxyHost, extensionConnection } = await import(new URL('cdp.js', location.href).href);
  const opened =
    transport === 'link'
      ? await globalThis.sliccCdp({ runtime })
      : guardProtected(
          transport === 'proxy'
            ? await proxyHost(proxy)()
            : extensionConnection(globalThis.sliccExtension.cdp),
          self.origin
        );
  const pending = new Map();
  const pauses = [];
  let next = 0;
  opened.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.method === 'Fetch.requestPaused') pauses.push(message);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      next += 1;
      const id = next;
      const timer = setTimeout(
        () => resolve({ error: { message: `${method} got no answer` } }),
        15000
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      opened.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const seven = (path) => `https://seven.sliccy.ai:${port}${path}`;
  const vault = (path) => `https://vault.sliccy.ai:${port}${path}`;
  const ordinary = (path) => `https://ordinary.test:${port}${path}`;
  const rows = [];
  const note = (name, origin, answer) =>
    rows.push({ name, origin, error: answer?.error?.message ?? '' });
  for (const [origin, url] of [
    ['seven', seven('/c/create')],
    ['vault', vault('/c/create')],
  ]) {
    note('Target.createTarget', origin, await send('Target.createTarget', { url }));
  }
  const created = await send('Target.createTarget', { url: ordinary('/idle') });
  const targetId = created.result?.targetId;
  const session = (await send('Target.attachToTarget', { targetId, flatten: true })).result
    ?.sessionId;
  if (!session) return { error: `attach: ${JSON.stringify(created)}`, rows };
  await send('Page.enable', {}, session);
  await send('Network.enable', {}, session);
  await send('Runtime.enable', {}, session);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, session);
  const frame = (await send('Page.getFrameTree', {}, session)).result?.frameTree?.frame?.id;
  for (const [origin, url] of [
    ['seven', seven('/c/load')],
    ['vault', vault('/c/load')],
  ]) {
    note(
      'Network.loadNetworkResource',
      origin,
      await send(
        'Network.loadNetworkResource',
        { frameId: frame, url, options: { disableCache: true, includeCredentials: true } },
        session
      )
    );
  }
  for (const [origin, url] of [
    ['seven', seven('/c/navigate')],
    ['vault', vault('/c/navigate')],
  ]) {
    note('Page.navigate', origin, await send('Page.navigate', { url }, session));
  }
  const take = async (match) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = pauses.findIndex(match);
      if (found >= 0) return pauses.splice(found, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  };
  const pauseFor = async (path) => {
    await send(
      'Runtime.evaluate',
      {
        expression: `fetch(${JSON.stringify(ordinary(path))}, {cache:'no-store'})`,
        returnByValue: true,
      },
      session
    );
    return take(
      (message) =>
        message.params.request?.url?.includes(path) &&
        message.params.responseStatusCode === undefined
    );
  };
  for (const [origin, url] of [
    ['seven', seven('/c/override')],
    ['vault', vault('/c/override')],
  ]) {
    const paused = await pauseFor(`/ping-${origin}`);
    note(
      'Fetch.continueRequest',
      origin,
      paused
        ? await send('Fetch.continueRequest', { requestId: paused.params.requestId, url }, session)
        : { error: { message: 'no pause' } }
    );
  }
  for (const [origin, url] of [
    ['seven', seven('/c/hop')],
    ['vault', vault('/c/hop')],
  ]) {
    const started = await pauseFor(`/bounce?${origin}`);
    if (started)
      await send('Fetch.continueRequest', { requestId: started.params.requestId }, session);
    const hop = await take((message) => message.params.redirectedRequestId !== undefined);
    note(
      'Fetch.continueRequest hop',
      origin,
      hop
        ? await send('Fetch.continueRequest', { requestId: hop.params.requestId, url }, session)
        : { error: { message: 'no hop' } }
    );
  }
  for (const [origin, url] of [
    ['seven', seven('/c/fulfill')],
    ['vault', vault('/c/fulfill')],
  ]) {
    const paused = await pauseFor(`/fulfill-${origin}`);
    note(
      'Fetch.fulfillRequest',
      origin,
      paused
        ? await send(
            'Fetch.fulfillRequest',
            {
              requestId: paused.params.requestId,
              responseCode: 302,
              responseHeaders: [{ name: 'Location', value: url }],
            },
            session
          )
        : { error: { message: 'no pause' } }
    );
  }
  const authPaused = await pauseFor('/auth-src');
  note(
    'Fetch.continueWithAuth',
    'seven',
    authPaused
      ? await send(
          'Fetch.continueWithAuth',
          {
            requestId: authPaused.params.requestId,
            authChallengeResponse: { response: 'Default', url: seven('/c/auth') },
          },
          session
        )
      : { error: { message: 'no pause' } }
  );
  await send(
    'Runtime.evaluate',
    { expression: `location.href=${JSON.stringify(seven('/c/history'))}`, returnByValue: true },
    session
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const history = await send('Page.getNavigationHistory', {}, session);
  const entries = history.result?.entries ?? [];
  for (const entry of entries) {
    note(
      'Page.navigateToHistoryEntry',
      entry.url ?? '',
      await send('Page.navigateToHistoryEntry', { entryId: entry.id }, session)
    );
  }
  if (!entries.length)
    note('Page.navigateToHistoryEntry', 'seven', { error: { message: 'no entries' } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await send('Target.closeTarget', { targetId });
  return { rows };
}

function rows(route) {
  const lines = [];
  let credentialed = false;
  for (const type of TYPES) {
    for (const how of HOWS) {
      for (const origin of ORIGINS) {
        const matched = hits.filter(
          (hit) =>
            hit.path === `/t/${type}/${how}/${origin}` &&
            hit.host.startsWith(origin === 'vault' ? 'vault.' : 'seven.')
        );
        const cookies = [...new Set(matched.map((hit) => hit.cookie).filter(Boolean))];
        const authorization = [...new Set(matched.map((hit) => hit.authorization).filter(Boolean))];
        const landed = matched.length > 0;
        if (landed && (cookies.length || authorization.length)) credentialed = true;
        lines.push(
          `ROW ${route} ${type} ${how} ${origin} ${landed ? 'yes' : 'no'} cookie=${cookies.join(' | ') || '-'} authorization=${authorization.join(' | ') || '-'}`
        );
      }
    }
  }
  const ordinary = TYPES.map((type) => {
    const count = hits.filter(
      (hit) => hit.host === 'other.test' && hit.path === `/t/${type}/direct/other`
    ).length;
    return `ORDINARY ${route} ${type} ${count}`;
  });
  return { credentialed, lines, ordinary };
}

async function check(t, transport) {
  hits.length = 0;
  const page = await chrome.page(t);
  let proxy;
  let runtime;
  let linked;
  if (transport === 'proxy') {
    proxy = await startProxy({
      port: 0,
      origins: [new URL(chrome.url).origin],
      cdp: `http://127.0.0.1:${debugging}`,
      kernelPort: null,
      log: () => {},
    });
    t.after(() => proxy.close());
  } else if (transport === 'extension') {
    const extension = await fakeExtension(page);
    t.after(() => extension.close());
  } else {
    linked = await bridge(version.webSocketDebuggerUrl);
    t.after(() => linked.close());
    await page.init(() => {
      globalThis.sliccCdpDebug = true;
    });
  }
  await page.goto(proxy ? `/#${new URLSearchParams({ proxy: proxy.url, key: proxy.key })}` : '/');
  await ready(page);
  if (transport === 'link') {
    await page.evaluate(fakeNode, linked.url);
    await page.until(
      () =>
        document
          .querySelector('slicc-app')
          .model.network.status()
          .links?.devices.find((item) => item.browsers?.length)?.browsers[0]?.runtime ===
        'fake-node/chrome'
    );
    runtime = 'fake-node/chrome';
  }
  const args = {
    transport,
    proxy: proxy && { url: proxy.url, key: proxy.key },
    runtime,
  };
  const report = await page.evaluate(rig, {
    ...args,
    url: `https://ordinary.test:${port}/drive`,
  });
  const built = rows(transport);
  const client = await page.evaluate(clients, { ...args, port });
  const clientHits = hits.filter((hit) => hit.path.startsWith('/c/'));
  const text = [
    'C5: a page may request a protected origin, and the request carries no cookie',
    ...built.lines,
    ...built.ordinary,
    `page ${JSON.stringify(report)}`,
    `client ${JSON.stringify(client)}`,
    ...clientHits.map(
      (hit) => `HIT ${hit.method} ${hit.host} ${hit.path} cookie=${hit.cookie || '-'}`
    ),
  ].join('\n');
  assert.equal(report.title, 'DROVE', text);
  assert.ok(
    built.ordinary.every((line) => Number(line.split(' ').at(-1)) > 0),
    text
  );
  assert.ok(
    built.lines.some(
      (line) => line.includes(' fetch direct seven yes ') && line.includes('cookie=-')
    ),
    text
  );
  assert.ok(
    built.lines.some(
      (line) => line.includes(' fetch direct vault yes ') && line.includes('cookie=-')
    ),
    text
  );
  assert.ok(
    built.lines.filter((line) => line.includes(' yes ')).every((line) => line.includes('cookie=-')),
    text
  );
  assert.ok(
    built.lines.filter((line) => line.includes(' iframe ')).every((line) => line.includes(' no ')),
    text
  );
  assert.equal(client.error, undefined, text);
  assert.ok(
    client.rows.some(
      (row) => row.name === 'Page.navigateToHistoryEntry' && /refused/.test(row.error)
    ),
    text
  );
  for (const row of client.rows) {
    if (row.name === 'Fetch.continueWithAuth') {
      assert.match(row.error, /refused/, text);
      continue;
    }
    if (row.name === 'Page.navigateToHistoryEntry' && !/sliccy\.ai|chrome-error/.test(row.origin)) {
      continue;
    }
    assert.match(row.error, /refused/, `${row.name} ${row.origin}\n${text}`);
  }
  assert.deepEqual(clientHits, [], text);
}

for (const transport of ['extension', 'proxy', 'link']) {
  test(
    `C5: a page may request a protected origin with no cookie, and a guarded client cannot name one, on the ${transport} path`,
    { timeout: 10 * 60 * 1000 },
    (t) => check(t, transport)
  );
}
