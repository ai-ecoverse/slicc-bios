const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seen = { connections: 0, closed: {} };

function joined(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

async function head(reader) {
  let held = new Uint8Array(0);
  for (;;) {
    const at = dec.decode(held).indexOf('\r\n\r\n');
    if (at >= 0) {
      const text = dec.decode(held).slice(0, at);
      return { text, rest: held.slice(enc.encode(text).length + 4) };
    }
    const { value, done } = await reader.read();
    if (done) return null;
    held = joined(held, value);
  }
}

async function body(reader, rest, length) {
  let held = rest;
  while (held.length < length) {
    const { value, done } = await reader.read();
    if (done) break;
    held = joined(held, value);
  }
  let extra = held.length - Math.min(held.length, length);
  const more = await Promise.race([reader.read(), sleep(300).then(() => null)]);
  if (more && !more.done) extra += more.value.length;
  return { text: dec.decode(held.slice(0, length)), extra };
}

const closing = async (reader, name) => {
  for (;;) {
    const { done } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
  }
  seen.closed[name] = (seen.closed[name] ?? 0) + 1;
};

const answer = (status, headers, text = '') => {
  const bytes = enc.encode(text);
  const lines = [
    `HTTP/1.1 ${status} X`,
    ...headers,
    `Content-Length: ${bytes.length}`,
    'Connection: close',
    '',
    '',
  ];
  return joined(enc.encode(lines.join('\r\n')), bytes);
};

const chunk = (text) => enc.encode(`${enc.encode(text).length.toString(16)}\r\n${text}\r\n`);

async function serve(conn, port) {
  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();
  seen.connections += 1;
  try {
    const got = await head(reader);
    if (!got) return;
    const [line, ...rows] = got.text.split('\r\n');
    const [method, target] = line.split(' ');
    const url = new URL(target, 'http://fixture');
    const headers = {};
    for (const row of rows) {
      const at = row.indexOf(':');
      const name = row.slice(0, at).trim().toLowerCase();
      headers[name] = headers[name]
        ? `${headers[name]}, ${row.slice(at + 1).trim()}`
        : row.slice(at + 1).trim();
    }
    const n = Number(url.searchParams.get('n') ?? 0);
    if (url.pathname === '/echo') {
      const sent = await body(reader, got.rest, Number(headers['content-length'] ?? 0));
      const json = JSON.stringify({ method, target, headers, body: sent.text, extra: sent.extra });
      await writer.write(
        answer(
          200,
          [
            'Content-Type: application/json',
            'Set-Cookie: a=1; Path=/',
            'Set-Cookie: b=2; HttpOnly',
          ],
          json
        )
      );
    } else if (url.pathname === '/redirect') {
      await writer.write(answer(302, [`Location: http://127.0.0.1:${port}/landed?from=1`]));
    } else if (url.pathname === '/elsewhere') {
      await writer.write(answer(302, ['Location: http://example.com/x']));
    } else if (url.pathname === '/count') {
      await writer.write(answer(200, ['Content-Type: application/json'], JSON.stringify(seen)));
    } else if (url.pathname === '/silent') {
      await closing(reader, 'silent');
    } else if (url.pathname === '/stall') {
      await writer.write(
        enc.encode(
          'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
        )
      );
      await writer.write(chunk('first\n'));
      await closing(reader, 'stall');
    } else if (url.pathname === '/drip') {
      await writer.write(
        enc.encode(
          'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
        )
      );
      for (let i = 1; i <= n; i += 1) {
        await writer.write(chunk(`data: ${i}\n\n`));
        await sleep(Number(url.searchParams.get('ms') ?? 100));
      }
      await writer.write(enc.encode('0\r\n\r\n'));
    } else if (url.pathname === '/big') {
      await writer.write(
        enc.encode(
          `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${n}\r\nConnection: close\r\n\r\n`
        )
      );
      const piece = new Uint8Array(64 * 1024).fill(7);
      for (let left = n; left > 0; left -= piece.length)
        await writer.write(left >= piece.length ? piece : piece.subarray(0, left));
    } else {
      await writer.write(answer(404, []));
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
    void serve(conn, listener.port);
  }
}
