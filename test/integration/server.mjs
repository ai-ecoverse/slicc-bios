import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../src/', import.meta.url));

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
};

export async function serve(port = 0) {
  const requests = [];
  const overrides = new Map();
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    requests.push(pathname);
    if (overrides.has(pathname)) {
      return response.writeHead(200, { 'content-type': types['.sh'] }).end(overrides.get(pathname));
    }
    const file = join(root, normalize(pathname).replace(/\/$/, '/index.html'));
    const found = file.startsWith(root) && (await stat(file).catch(() => null))?.isFile();
    if (!found) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': types[extname(file)], 'cache-control': 'no-cache' });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    overrides,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(Number(env.PORT ?? 8080));
  console.log(`slicc-bios on ${url}`);
}
