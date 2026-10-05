import { createServer } from 'node:http';

export async function fakeProxy({ origin, key }) {
  const probes = [];
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    probes,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
