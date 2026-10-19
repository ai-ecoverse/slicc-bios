const enc = new TextEncoder();
const dec = new TextDecoder();

const TOOLS = [
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

function answer(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return undefined;
  const result = (value) => ({ jsonrpc: '2.0', id, result: value });
  const error = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (method === 'initialize')
    return result({
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'bios-mcp-fixture', version: '1.0.0' },
    });
  if (method === 'tools/list') return result({ tools: TOOLS });
  if (method === 'tools/call' && params?.name === 'add') {
    const { a = 0, b = 0 } = params.arguments ?? {};
    return result({ content: [{ type: 'text', text: String(a + b) }] });
  }
  if (method === 'tools/call') return error(-32602, `Unknown tool: ${params?.name}`);
  return error(-32601, `Method not found: ${method}`);
}

async function stdio(ctx) {
  const reader = ctx.stdin.getReader();
  const writer = ctx.stdout.getWriter();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return 0;
    buffer += dec.decode(value, { stream: true });
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const reply = answer(JSON.parse(line));
      if (reply) await writer.write(enc.encode(`${JSON.stringify(reply)}\n`));
    }
  }
}

function crlf2(buf) {
  for (let i = 0; i + 3 < buf.length; i++)
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  return -1;
}

async function readRequest(reader) {
  let buf = new Uint8Array(0);
  let end = -1;
  let need = Number.POSITIVE_INFINITY;
  for (;;) {
    if (end < 0) {
      end = crlf2(buf);
      if (end >= 0) {
        const length = /\r\ncontent-length:\s*(\d+)/i.exec(dec.decode(buf.subarray(0, end)));
        need = end + 4 + (length ? Number(length[1]) : 0);
      }
    }
    if (buf.length >= need) break;
    const { value, done } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
  }
  if (end < 0) return undefined;
  const lines = dec.decode(buf.subarray(0, end)).split('\r\n');
  const [method] = lines[0].split(' ');
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { method, headers, body: dec.decode(buf.subarray(end + 4, need)) };
}

function respond(status, body, type = 'application/json') {
  const bytes = enc.encode(body);
  const head = enc.encode(
    `HTTP/1.1 ${status} X\r\nContent-Type: ${type}\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`
  );
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head);
  out.set(bytes, head.length);
  return out;
}

async function serve(ctx, conn) {
  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();
  try {
    const req = await readRequest(reader);
    if (!req) return;
    if (req.headers['x-api'] !== undefined)
      await ctx.write(1, `seen ${[...req.headers['x-api']].reverse().join('')}\n`);
    if (req.method !== 'POST') {
      await writer.write(respond(405, ''));
      return;
    }
    const reply = answer(JSON.parse(req.body));
    await writer.write(reply ? respond(200, JSON.stringify(reply)) : respond(202, ''));
  } catch (error) {
    await ctx.write(2, `fixture: ${error.message}\n`);
  } finally {
    await writer.close().catch(() => undefined);
    conn.close();
  }
}

async function http(ctx, port) {
  const listener = await ctx.net.listen({ port, host: '127.0.0.1' });
  await ctx.write(1, `listening ${listener.port}\n`);
  for (;;) {
    const conn = await listener.accept();
    void serve(ctx, conn);
  }
}

export default async function main(ctx) {
  if (ctx.argv[1] === 'http') return http(ctx, Number(ctx.argv[2] ?? 0));
  return stdio(ctx);
}
