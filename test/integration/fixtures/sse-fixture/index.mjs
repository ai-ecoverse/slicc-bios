const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let connections = 0;
const KINDS = {
  '/events': { type: 'text/event-stream', line: (id, n) => `data: ${id} ${n}\n\n` },
  '/ticks': { type: 'application/x-ndjson', line: (id, n) => `${JSON.stringify({ id, n })}\n` },
};

async function head(reader) {
  let text = '';
  while (!text.includes('\r\n\r\n')) {
    const { value, done } = await reader.read();
    if (done) return null;
    text += dec.decode(value, { stream: true });
  }
  return text.split('\r\n')[0];
}

function chunk(text) {
  const bytes = enc.encode(text);
  return enc.encode(`${bytes.length.toString(16)}\r\n${text}\r\n`);
}

async function serve(conn) {
  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();
  connections += 1;
  const id = connections;
  try {
    const line = await head(reader);
    const kind = KINDS[/^GET (\/\w+) /.exec(line ?? '')?.[1]];
    if (!kind) {
      await writer.write(
        enc.encode('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      );
      return;
    }
    await writer.write(
      enc.encode(
        `HTTP/1.1 200 OK\r\nContent-Type: ${kind.type}\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`
      )
    );
    for (let n = 1; ; n += 1) {
      await writer.write(chunk(kind.line(id, n)));
      await sleep(1000);
    }
  } catch {
  } finally {
    await writer.close().catch(() => undefined);
    conn.close();
  }
}

export default async function main(ctx) {
  const listener = await ctx.net.listen({ port: Number(ctx.argv[1]), host: '127.0.0.1' });
  await ctx.write(1, `listening ${listener.port}\n`);
  for (;;) {
    const conn = await listener.accept();
    void serve(conn);
  }
}
