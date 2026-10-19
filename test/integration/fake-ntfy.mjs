import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RESERVED = new Set(['v1', 'file', 'api', 'hook']);
const UNAUTHORIZED = {
  code: 40101,
  http: 401,
  error: 'unauthorized',
  link: 'https://ntfy.sh/docs/publish/#authentication',
};

const id = () => [...randomBytes(12)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
const now = () => Math.floor(Date.now() / 1000);

function pick(request, query, names) {
  for (const name of names) {
    const header = request.headers[name.toLowerCase()];
    if (header !== undefined) return header;
    if (query.has(name.toLowerCase())) return query.get(name.toLowerCase());
  }
  return undefined;
}

function utf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function sinceFilter(since, list) {
  if (since === undefined || since === 'none') return [];
  if (since === 'all') return list;
  if (since === 'latest') return list.slice(-1);
  if (/^\d+$/.test(since)) return list.filter((message) => message.time >= Number(since));
  const span = since.match(/^(\d+)([smhd])$/);
  if (span) {
    const seconds = Number(span[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[span[2]];
    return list.filter((message) => message.time >= now() - seconds);
  }
  const at = list.findIndex((message) => message.id === since);
  return at < 0 ? list : list.slice(at + 1);
}

export async function fakeNtfy({
  host = '127.0.0.1',
  keepalive = 45000,
  limit = 4096,
  tokens = {},
} = {}) {
  const messages = [];
  const files = new Map();
  const live = new Set();
  const requests = [];
  const opened = new Map();

  const allowed = (topic, request, query) => {
    const token = tokens[topic];
    if (!token) return true;
    const header = request.headers.authorization ?? '';
    if (header === `Bearer ${token}`) return true;
    if (header.startsWith('Basic ')) {
      const [, password] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      if (password === token) return true;
    }
    const auth = query.get('auth');
    return !!auth && Buffer.from(auth, 'base64url').toString() === `Bearer ${token}`;
  };

  const send = (response, status, body, type = 'application/json') => {
    response.writeHead(status, { ...response.cors, 'content-type': type });
    response.end(
      typeof body === 'string' || Buffer.isBuffer(body) ? body : `${JSON.stringify(body)}\n`
    );
  };

  function store(topic, fields, base, bytes = null) {
    const message = {
      id: id(),
      time: now(),
      expires: now() + 43200,
      event: 'message',
      topic,
      ...fields,
    };
    if (bytes) {
      const text = utf8(bytes);
      const ext = text ? '.txt' : '.bin';
      const name = fields.filename ?? `attachment${ext}`;
      delete message.filename;
      files.set(`${message.id}${ext}`, bytes);
      message.message = fields.message ?? `You received a file: ${name}`;
      message.attachment = {
        name,
        type: text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        size: bytes.length,
        expires: message.expires,
        url: `${base}/file/${message.id}${ext}`,
      };
    }
    messages.push(message);
    for (const stream of live)
      if (stream.topics.includes(topic)) stream.response.write(`${JSON.stringify(message)}\n`);
    return message;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://ntfy');
    const query = url.searchParams;
    const base = `http://${request.headers.host}`;
    response.cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
      'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
      'access-control-expose-headers': '*',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, response.cors);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const parts = url.pathname.split('/').filter(Boolean);
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(query),
      authorization: request.headers.authorization ?? null,
      size: body.length,
    });

    if (url.pathname === '/v1/health') return send(response, 200, { healthy: true });
    if (parts[0] === 'file' && parts.length === 2) {
      const bytes = files.get(parts[1]);
      return bytes
        ? send(response, 200, bytes, 'application/octet-stream')
        : send(response, 404, { code: 40401, http: 404, error: 'page not found' });
    }

    if (request.method === 'POST' && parts.length === 0) {
      let fields;
      try {
        fields = JSON.parse(body.toString());
      } catch {
        return send(response, 400, {
          code: 40024,
          http: 400,
          error: 'invalid request: body is not JSON',
        });
      }
      const { topic, ...rest } = fields;
      if (!allowed(topic, request, query)) return send(response, 401, UNAUTHORIZED);
      return send(response, 200, store(topic, rest, base));
    }

    const topics = (parts[0] ?? '').split(',').filter(Boolean);
    if (!topics.length || topics.some((topic) => RESERVED.has(topic)))
      return send(response, 404, { code: 40401, http: 404, error: 'page not found' });
    if (topics.some((topic) => !allowed(topic, request, query)))
      return send(response, 401, UNAUTHORIZED);

    if ((request.method === 'PUT' || request.method === 'POST') && parts.length === 1) {
      const fields = {};
      const title = pick(request, query, ['X-Title', 'Title', 'ti', 't']);
      const tags = pick(request, query, ['X-Tags', 'Tags', 'tag', 'ta']);
      const priority = pick(request, query, ['X-Priority', 'Priority', 'prio', 'p']);
      const filename = pick(request, query, ['X-Filename', 'Filename', 'file', 'f']);
      const header = pick(request, query, ['X-Message', 'Message', 'm']);
      if (title !== undefined) fields.title = title;
      if (tags !== undefined) fields.tags = tags.split(',').map((tag) => tag.trim());
      if (priority !== undefined) fields.priority = Number(priority);
      if (filename !== undefined) fields.filename = filename;
      const big = body.length > limit || !utf8(body) || filename !== undefined;
      if (header !== undefined) fields.message = header;
      else if (!big) fields.message = body.toString() || 'triggered';
      return send(response, 200, store(topics[0], fields, base, big ? body : null));
    }

    if (request.method === 'GET' && parts[1] === 'auth')
      return send(response, 200, { success: true });

    if (request.method === 'GET' && parts[1] === 'json') {
      const poll = ['1', 'true', 'yes'].includes(query.get('poll') ?? '');
      const since = query.get('since') ?? (poll ? 'all' : undefined);
      const backlog = sinceFilter(
        since,
        messages.filter((message) => topics.includes(message.topic))
      );
      response.writeHead(200, {
        ...response.cors,
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
      });
      if (poll) {
        response.end(backlog.map((message) => `${JSON.stringify(message)}\n`).join(''));
        return;
      }
      for (const topic of topics) opened.set(topic, (opened.get(topic) ?? 0) + 1);
      const open = { id: id(), time: now(), event: 'open', topic: topics.join(',') };
      response.write(`${JSON.stringify(open)}\n`);
      for (const message of backlog) response.write(`${JSON.stringify(message)}\n`);
      const stream = { topics, response };
      live.add(stream);
      const timer = setInterval(() => {
        const beat = { id: id(), time: now(), event: 'keepalive', topic: topics.join(',') };
        response.write(`${JSON.stringify(beat)}\n`);
      }, keepalive);
      response.on('close', () => {
        clearInterval(timer);
        live.delete(stream);
      });
      return;
    }

    return send(response, 404, { code: 40401, http: 404, error: 'page not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    messages,
    requests,
    publish: (topic, fields, bytes = null) => store(topic, fields, `http://${host}:${port}`, bytes),
    streams: (topic) => [...live].filter((stream) => stream.topics.includes(topic)).length,
    opened: (topic) => opened.get(topic) ?? 0,
    close: () =>
      new Promise((resolve) => {
        for (const stream of live) stream.response.destroy();
        server.close(resolve);
      }),
  };
}
