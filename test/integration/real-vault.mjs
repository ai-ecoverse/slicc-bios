import { createServer } from 'node:http';

const SOURCE = 'https://vault-preview.sliccy.ai/';

export async function realVault(origin) {
  const cached = new Map();
  const config = await fetch(new URL('config.json', SOURCE), {
    signal: AbortSignal.timeout(30000),
  }).then((r) => {
    if (!r.ok) throw new Error('the vault deployment is unavailable');
    return r.json();
  });
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://fixture').pathname;
      let body;
      let type;
      if (path === '/config.json' || path === '/embedders.json') {
        body = Buffer.from(JSON.stringify({ ...config, embedders: [origin] }));
        type = 'application/json';
      } else {
        let asset = cached.get(path);
        if (!asset) {
          const upstream = await fetch(new URL(path, SOURCE), {
            signal: AbortSignal.timeout(30000),
          });
          if (!upstream.ok) throw new Error('the vault deployment asset is unavailable');
          asset = {
            body: Buffer.from(await upstream.arrayBuffer()),
            type: upstream.headers.get('content-type') ?? 'application/octet-stream',
          };
          cached.set(path, asset);
        }
        ({ body, type } = asset);
      }
      response.writeHead(200, {
        'content-type': type,
        'content-security-policy': `frame-ancestors ${origin}`,
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'cross-origin',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(502);
      response.end('the vault deployment is unavailable');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    version: config.version,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
