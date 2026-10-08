import { createServer } from 'node:http';
import { crc32 } from 'node:zlib';

const RAW = 'application/vnd.slicc.raw-fetch';

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

export function eventFrame(type, body) {
  const headers = Buffer.concat(
    Object.entries({
      ':event-type': type,
      ':message-type': 'event',
      ':content-type': 'application/json',
    }).map(([name, value]) => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(Buffer.byteLength(value));
      return Buffer.concat([
        Buffer.from([Buffer.byteLength(name)]),
        Buffer.from(name),
        Buffer.from([7]),
        length,
        Buffer.from(value),
      ]);
    })
  );
  const payload = Buffer.from(JSON.stringify(body));
  const prelude = Buffer.concat([
    uint32(16 + headers.length + payload.length),
    uint32(headers.length),
  ]);
  const head = Buffer.concat([prelude, uint32(crc32(prelude)), headers, payload]);
  return Buffer.concat([head, uint32(crc32(head))]);
}

export function rawResponse(status, headers, body) {
  const head = Buffer.from(JSON.stringify({ status, statusText: '', headers }));
  return Buffer.concat([uint32(head.length), head, body]);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function fakeProxy({ origin, key, port = 0, answer }) {
  const probes = [];
  const requests = [];
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  const nonces = new Map();
  const dropped = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x');
    const nonce = path.searchParams.get('nonce');
    if (path.pathname === '/auth/callback' && req.method === 'GET') {
      const state = nonces.get(nonce);
      const fresh = state && !state.visited;
      if (fresh) state.visited = true;
      res.writeHead(fresh ? 200 : 403, { 'Content-Type': 'text/html' });
      res.end(
        fresh
          ? `<script>const redirectUrl = location.href; history.replaceState(null, '', location.pathname); fetch('/auth/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: ${JSON.stringify(nonce)}, redirectUrl }) }).then(() => window.close());</script>`
          : 'unknown sign-in'
      );
      return;
    }
    if (path.pathname === '/auth/callback' && req.method === 'POST') {
      void readBody(req).then((body) => {
        const sent = JSON.parse(body.toString());
        const state = nonces.get(sent.nonce);
        const ok =
          state?.visited && !state.result && /^http:\/\/localhost:\d+$/.test(req.headers.origin);
        if (ok) state.result = sent.redirectUrl;
        res.writeHead(ok ? 204 : 403);
        res.end();
      });
      return;
    }
    const oauth = path.pathname === '/api/oauth-state' || path.pathname === '/api/oauth-result';
    if (oauth && req.headers.origin === origin) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
        });
        res.end();
        return;
      }
      if (req.headers['x-bridge-token'] !== key) {
        res.writeHead(403, cors);
        res.end();
        return;
      }
      if (path.pathname === '/api/oauth-result') {
        const state = nonces.get(nonce);
        if (state?.result) nonces.delete(nonce);
        res.writeHead(!state ? 404 : state.result ? 200 : 204, {
          ...cors,
          'Content-Type': 'application/json',
        });
        res.end(state?.result ? JSON.stringify({ redirectUrl: state.result }) : undefined);
        return;
      }
      if (req.method === 'DELETE') {
        dropped.push(nonce);
        nonces.delete(nonce);
        res.writeHead(204, cors);
        res.end();
        return;
      }
      void readBody(req).then((body) => {
        nonces.set(JSON.parse(body.toString()).nonce, { visited: false, result: null });
        res.writeHead(204, cors);
        res.end();
      });
      return;
    }
    if (req.url !== '/api/fetch-proxy' || req.headers.origin !== origin) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Bridge-Token, X-Slicc-Raw-Request, X-Slicc-Raw-Probe',
      });
      res.end();
      return;
    }
    const raw = req.headers['x-slicc-raw-request'];
    if (raw && answer && req.headers['x-bridge-token'] === key) {
      const request = JSON.parse(raw);
      void readBody(req).then(async (body) => {
        requests.push({ ...request, body: body.toString() });
        const { status, headers, body: reply } = await answer(request, body);
        res.writeHead(200, { ...cors, 'Content-Type': RAW });
        res.end(rawResponse(status, headers, reply));
      });
      return;
    }
    probes.push(req.headers['x-bridge-token']);
    if (req.headers['x-bridge-token'] !== key || !req.headers['x-slicc-raw-probe']) {
      res.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy key missing or wrong' }));
      return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ rawFetch: 1, requestBodyStreaming: false, maxRequestBodyBytes: 1024 })
    );
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    probes,
    dropped,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
