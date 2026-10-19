import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const PATH = /^\/repos\/([^/]+\/[^/]+)\/releases$/;

export async function startFakeGitHub() {
  const state = { repos: new Map(), status: 0, requests: [] };
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'accept, if-none-match',
    'access-control-expose-headers': 'etag, retry-after, x-ratelimit-remaining, x-ratelimit-reset',
  };
  const server = createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const url = new URL(request.url, 'http://fake');
    const seen = {
      path: url.pathname,
      query: url.search,
      headers: request.headers,
      status: 0,
      etag: null,
    };
    state.requests.push(seen);
    if (state.status) {
      seen.status = state.status;
      response.writeHead(state.status, { ...cors, 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'API rate limit exceeded' }));
      return;
    }
    const match = url.pathname.match(PATH);
    if (!match) {
      response.writeHead(404, cors);
      response.end('{}');
      return;
    }
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    const all = state.repos.get(match[1]) ?? [];
    const body = JSON.stringify(all.slice((page - 1) * per, page * per));
    const etag = `W/"${createHash('sha256').update(body).digest('hex')}"`;
    seen.etag = etag;
    if (request.headers['if-none-match'] === etag) {
      seen.status = 304;
      response.writeHead(304, { ...cors, etag });
      response.end();
      return;
    }
    seen.status = 200;
    response.writeHead(200, {
      ...cors,
      etag,
      'content-type': 'application/json',
      'x-ratelimit-remaining': '59',
    });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    releases(repo, list) {
      state.repos.set(repo, list);
    },
    reset() {
      state.repos.clear();
      state.status = 0;
      state.requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
