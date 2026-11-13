import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const SOURCE = 'https://vault-preview.sliccy.ai/';
const WARM = 60000;
const FETCH = 30000;

const timedOut = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';
const transient = (error) =>
  timedOut(error) ||
  error?.name === 'TypeError' ||
  ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(
    error?.cause?.code ?? error?.code
  );

async function once(path, timeout) {
  return fetch(new URL(path, SOURCE), { signal: AbortSignal.timeout(timeout) });
}

async function loadConfig() {
  try {
    await once('config.json', WARM);
  } catch {}
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await once('config.json', FETCH);
      if (!response.ok) throw new Error('the vault deployment is unavailable');
      return await response.json();
    } catch (error) {
      last = error;
      if (error.message === 'the vault deployment is unavailable') throw error;
      if (!transient(error) || attempt === 1) throw error;
    }
  }
  throw last;
}

async function pull(path) {
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await once(path, FETCH);
    } catch (error) {
      last = error;
      if (!timedOut(error) || attempt === 1) throw error;
    }
  }
  throw last;
}

export async function realVault(origin, { version } = {}) {
  const cached = new Map();
  const requests = [];
  const config = await loadConfig();
  if (config.version !== version)
    throw new Error(`the vault deployment version is ${config.version}, expected ${version}`);
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url, 'http://fixture').pathname;
      const entry = { path, startedAt: Date.now(), finishedAt: null, status: null };
      requests.push(entry);
      response.on('close', () => {
        entry.aborted = Boolean(entry.aborted) || !response.writableFinished;
      });
      try {
        let body;
        let type;
        if (path === '/config.json' || path === '/embedders.json') {
          body = Buffer.from(JSON.stringify({ ...config, embedders: [origin] }));
          type = 'application/json';
        } else {
          let asset = cached.get(path);
          entry.cached = Boolean(asset);
          if (!asset) {
            const upstream = await pull(path);
            entry.upstreamStatus = upstream.status;
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
        entry.status = 200;
        response.end(body);
      } catch (error) {
        entry.error = error?.name ?? 'Error';
        entry.status = timedOut(error) ? 504 : 502;
        if (timedOut(error)) entry.aborted = true;
        try {
          if (!response.headersSent) {
            response.writeHead(entry.status);
            response.end('the vault deployment is unavailable');
          } else {
            response.destroy();
          }
        } catch {
          response.destroy();
        }
      } finally {
        entry.finishedAt = Date.now();
      }
    })();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    version: config.version,
    evidence: () => ({
      version: config.version,
      source: SOURCE,
      requests: requests.map((request) => ({ ...request })),
      assets: [...cached].map(([path, asset]) => ({
        path,
        sha256: createHash('sha256').update(asset.body).digest('hex'),
      })),
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
