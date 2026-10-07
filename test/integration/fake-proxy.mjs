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
  const server = createServer((req, res) => {
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
      void readBody(req).then((body) => {
        requests.push({ ...request, body: body.toString() });
        const { status, headers, body: reply } = answer(request, body);
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
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
