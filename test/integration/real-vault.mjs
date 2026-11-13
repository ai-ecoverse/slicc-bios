import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@ai-ecoverse/slicc-vault';

export function vaultPackageRoot() {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (;;) {
    const manifest = join(dir, 'node_modules', PACKAGE, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name === PACKAGE) return dirname(manifest);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('the vault package is unavailable');
}

export function classForPath(pathname, classes) {
  for (const [name, spec] of Object.entries(classes)) {
    if (spec.paths?.includes(pathname)) return { name, ...spec };
  }
  const extension = extname(pathname);
  if (!extension) return null;
  for (const [name, spec] of Object.entries(classes)) {
    if (spec.extensions?.includes(extension)) return { name, ...spec };
  }
  return null;
}

export function headersForClass(spec, origin) {
  const headers = { ...spec.headers };
  if (headers['content-security-policy']) {
    headers['content-security-policy'] = headers['content-security-policy'].replace(
      /frame-ancestors[^;]*/,
      `frame-ancestors ${origin}`
    );
  }
  return headers;
}

function locate(root, pathname) {
  const rel = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const file = join(root, normalize(rel));
  return file.startsWith(`${root}${sep}`) ? file : null;
}

export async function realVault(origin, { version } = {}) {
  const root = vaultPackageRoot();
  const site = join(root, 'dist/site');
  const headersDoc = JSON.parse(readFileSync(join(root, 'dist/headers.json'), 'utf8'));
  const config = JSON.parse(readFileSync(join(site, 'config.json'), 'utf8'));
  if (config.version !== version)
    throw new Error(`the vault deployment version is ${config.version}, expected ${version}`);
  const cached = new Map();
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url, 'http://fixture').pathname;
      const entry = { path, startedAt: Date.now(), finishedAt: null, status: null };
      requests.push(entry);
      response.on('close', () => {
        entry.aborted = Boolean(entry.aborted) || !response.writableFinished;
      });
      try {
        const klass = classForPath(path, headersDoc.classes);
        if (!klass) throw new Error('the vault deployment asset is unavailable');
        const headers = headersForClass(klass, origin);
        let body;
        if (path === '/config.json' || path === '/embedders.json') {
          body = Buffer.from(JSON.stringify({ ...config, embedders: [origin] }));
        } else {
          let asset = cached.get(path);
          entry.cached = Boolean(asset);
          if (!asset) {
            const file = locate(site, path);
            const info = file && existsSync(file) ? statSync(file) : null;
            entry.upstreamStatus = info?.isFile() ? 200 : 404;
            if (!info?.isFile()) throw new Error('the vault deployment asset is unavailable');
            asset = { body: readFileSync(file) };
            cached.set(path, asset);
          }
          ({ body } = asset);
        }
        response.writeHead(200, headers);
        entry.status = 200;
        response.end(body);
      } catch (error) {
        entry.error = error?.name ?? 'Error';
        entry.status = entry.upstreamStatus === 404 ? 404 : 502;
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
    site,
    headers: headersDoc,
    evidence: () => ({
      version: config.version,
      source: site,
      requests: requests.map((request) => ({ ...request })),
      assets: [...cached].map(([path, asset]) => ({
        path,
        sha256: createHash('sha256').update(asset.body).digest('hex'),
      })),
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
