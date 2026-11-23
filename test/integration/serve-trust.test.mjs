import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const SEED = new URL('../../src/seed/', import.meta.url);
const enc = new TextEncoder();
const dec = new TextDecoder();

const MUTANTS = {
  port: [
    'const target = { port: entry.port };',
    'const target = { port: message.port ?? entry.port, host: message.host };',
  ],
  stale: [
    'if (!entry) return void respond(stream, plain(404, GONE));\n      const target = { port: entry.port };',
    'const target = { port: entry?.port ?? 80 };',
  ],
  head: [
    '    arm(\n      stream,\n      limits.headMs,',
    '    void (\n      stream,\n      limits.headMs,',
  ],
  idle: [
    '  const progress = (stream) =>\n    arm(',
    '  const progress = (stream) =>\n    timers.clearTimeout(stream.timer) || void (',
  ],
  long: ['      if (counted) progress(stream);\n', ''],
  cap: [
    'const busy = streams.size >= limits.streams || held >= limits.perPreview;',
    'const busy = false;',
  ],
  window: ['while (live(stream) && stream.sent - stream.acked + size > WINDOW)', 'while (false)'],
  length: [
    'const kept = stream.left === null ? bytes : bytes.subarray(0, stream.left);',
    'const kept = bytes;',
  ],
  method: ["if (method === 'CONNECT' || method === 'TRACE')", 'if (false)'],
  forwarded: ['request.host = hostOf(entry.url);', 'request.host = hostOf(message.url);'],
  freed: [
    'if (stream.token === token) cancel(stream, GONE);',
    'if (stream.token === token) undefined;',
  ],
};

registerHooks({
  load(url, context, next) {
    const mutant = URL.parse(url)?.searchParams.get('mutant');
    const loaded = next(url, context);
    if (!mutant) return loaded;
    const [from, to] = MUTANTS[mutant];
    const source = String(loaded.source);
    assert.ok(source.includes(from), `mutant ${mutant}: ${from} is not in the source`);
    return { ...loaded, source: source.replace(from, to) };
  },
});

const load = (mutant) =>
  import(`${new URL('serve-http.js', SEED).href}${mutant ? `?mutant=${mutant}` : ''}`);

function fakeTimers() {
  const due = new Set();
  let now = 0;
  return {
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms };
      due.add(timer);
      return timer;
    },
    clearTimeout: (timer) => due.delete(timer),
    advance(ms) {
      now += ms;
      for (const timer of [...due].sort((x, y) => x.at - y.at))
        if (timer.at <= now && due.delete(timer)) timer.fn();
    },
  };
}

function port() {
  const written = [];
  let push;
  let closed = false;
  const readable = new ReadableStream({
    start(controller) {
      push = controller;
    },
  });
  const writable = new WritableStream({
    write(chunk) {
      written.push(dec.decode(chunk));
    },
  });
  return {
    socket: {
      readable,
      writable,
      close() {
        closed = true;
        try {
          push.close();
        } catch {}
      },
    },
    written: () => written.join(''),
    closed: () => closed,
    say: (text) => push.enqueue(enc.encode(text)),
    push: (bytes) => push.enqueue(bytes),
  };
}

const LIMITS = { headMs: 1000, idleMs: 2000, perPreview: 2, streams: 3 };
const MINTED = 'https://minted.sliccy.now/';

async function relay(mutant, { held = { tok: 8400, two: 8401 }, acking = false } = {}) {
  const { httpRelay, unframe } = await load(mutant);
  const sent = [];
  const dials = [];
  const ports = [];
  const timers = fakeTimers();
  const flight = { now: 0, max: 0, bytes: 0 };
  let r;
  const r0 = httpRelay({
    dial: async (target) => {
      dials.push(target);
      const next = port();
      ports.push(next);
      return next.socket;
    },
    send: (message) => {
      if (!(acking && message instanceof Uint8Array)) return void sent.push(message);
      const { id, bytes } = unframe(message);
      flight.now += bytes.byteLength;
      flight.bytes += bytes.byteLength;
      flight.max = Math.max(flight.max, flight.now);
      setImmediate(() => {
        flight.now -= bytes.byteLength;
        r.ack({ id, bytes: bytes.byteLength });
      });
    },
    origin: (token) => (held[token] ? { port: held[token], url: MINTED } : null),
    timers,
    limits: LIMITS,
  });
  r = r0;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const json = () => sent.filter((m) => !(m instanceof Uint8Array));
  const of = (id) => json().filter((m) => m.id === id);
  const status = (id) => of(id).find((m) => m.type === 'http.response')?.status;
  const bytes = (id) =>
    sent
      .filter((m) => m instanceof Uint8Array)
      .map(unframe)
      .filter((f) => f.id === id)
      .reduce((n, f) => n + f.bytes.byteLength, 0);
  return { r, sent, dials, ports, timers, settle, of, status, bytes, flight };
}

const ask = (id, extra = {}) => ({
  type: 'http.request',
  id,
  previewToken: 'tok',
  method: 'GET',
  url: 'https://l.sliccy.now/',
  path: '/',
  headers: [],
  body: false,
  ...extra,
});

const ROWS = {
  port: async (mutant) => {
    const h = await relay(mutant);
    h.r.request(ask(1, { port: 22, host: '10.0.0.1' }));
    await h.settle();
    assert.deepEqual(h.dials, [{ port: 8400 }], "the dial goes to the held preview's port only");
  },
  stale: async (mutant) => {
    const h = await relay(mutant);
    h.r.request(ask(1, { previewToken: 'gone' }));
    await h.settle();
    assert.equal(h.status(1), 404);
    assert.deepEqual(h.dials, [], 'a token seven no longer holds dials nothing');
  },
  head: async (mutant) => {
    const h = await relay(mutant);
    h.r.request(ask(1));
    await h.settle();
    h.timers.advance(LIMITS.headMs);
    await h.settle();
    assert.equal(h.status(1), 504, 'a port that sends no head is a 504');
    assert.equal(h.ports[0].closed(), true, 'and its connection is closed');
    assert.equal(h.r.open(), 0);
  },
  idle: async (mutant) => {
    const h = await relay(mutant);
    h.r.request(ask(1));
    await h.settle();
    h.ports[0].say('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n');
    await h.settle();
    h.timers.advance(LIMITS.idleMs);
    await h.settle();
    assert.ok(
      h.of(1).some((m) => m.type === 'http.cancel'),
      'a body that stops moving is cancelled'
    );
    assert.equal(h.ports[0].closed(), true);
  },
  long: async (mutant) => {
    const h = await relay(mutant);
    h.r.request(ask(1));
    await h.settle();
    h.ports[0].say('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
    await h.settle();
    for (let n = 0; n < 100; n += 1) {
      h.timers.advance(1500);
      h.ports[0].say('1\r\nx\r\n');
      await h.settle();
    }
    assert.ok(!h.of(1).some((m) => m.type === 'http.cancel'), 'a stream that keeps sending stays');
    assert.equal(h.ports[0].closed(), false, 'still open after 150 s, past any 120 s cap');
    h.ports[0].say('0\r\n\r\n');
    await h.settle();
    assert.ok(h.of(1).some((m) => m.type === 'http.response.end'));
    assert.equal(h.bytes(1), 100, 'and delivers everything');
  },
  cap: async (mutant) => {
    const h = await relay(mutant);
    for (const id of [1, 2, 3]) h.r.request(ask(id));
    await h.settle();
    h.r.request(ask(4, { previewToken: 'two' }));
    h.r.request(ask(5, { previewToken: 'two' }));
    await h.settle();
    assert.equal(h.status(3), 503, 'over the per-preview cap is a 503');
    assert.equal(h.status(5), 503, 'over the cap of all streams is a 503');
    assert.equal(h.dials.length, 3, 'and dials nothing');
  },
  window: async (mutant) => {
    const { WINDOW } = await load();
    const h = await relay(mutant, { acking: true });
    const size = 65 * 1024 * 1024 + 1;
    h.r.request(ask(1));
    await h.settle();
    h.ports[0].say(`HTTP/1.1 200 OK\r\nContent-Length: ${size}\r\n\r\n`);
    const mib = new Uint8Array(1024 * 1024);
    for (let left = size; left > 0; left -= mib.byteLength)
      h.ports[0].push(left >= mib.byteLength ? mib : mib.subarray(0, left));
    for (let n = 0; n < 2000 && !h.of(1).some((m) => m.type === 'http.response.end'); n += 1)
      await h.settle();
    assert.equal(h.flight.bytes, size, 'an answer far over 64 MiB streams through completely');
    assert.ok(h.flight.max <= WINDOW, `at most the 1 MiB window in flight, not ${h.flight.max}`);
  },
  length: async (mutant) => {
    const { frame } = await load();
    const h = await relay(mutant);
    h.r.request(ask(1, { method: 'POST', body: true, headers: [['content-length', '3']] }));
    await h.settle();
    h.r.body(frame(1, enc.encode('abcGET /admin HTTP/1.1\r\n\r\n')));
    h.r.end({ id: 1 });
    await h.settle();
    assert.ok(h.ports[0].written().endsWith('\r\n\r\nabc'), 'exactly Content-Length bytes go on');
    assert.ok(h.of(1).some((m) => m.type === 'http.ack'));
  },
  method: async (mutant) => {
    const h = await relay(mutant);
    h.r.request(ask(1, { method: 'CONNECT' }));
    h.r.request(ask(2, { method: 'TRACE' }));
    await h.settle();
    assert.deepEqual([h.status(1), h.status(2)], [405, 405]);
    assert.deepEqual(h.dials, []);
  },
  forwarded: async (mutant) => {
    const h = await relay(mutant);
    h.r.request(ask(1, { url: 'https://attacker.example/' }));
    await h.settle();
    assert.match(h.ports[0].written(), /\r\nX-Forwarded-Host: minted\.sliccy\.now\r\n/);
  },
  freed: async (mutant) => {
    const h = await relay(mutant);
    h.r.request(ask(1));
    h.r.request(ask(2, { previewToken: 'two' }));
    await h.settle();
    h.r.drop('tok');
    assert.equal(h.ports[0].closed(), true, "unpublishing closes the preview's streams");
    assert.equal(h.r.open(), 1);
    h.r.closeAll();
    assert.equal(h.r.open(), 0);
  },
};

for (const [name, row] of Object.entries(ROWS)) {
  test(`serve relay trust row: ${name}`, () => row(null));
  test(`serve relay trust mutant: without the ${name} check, its row fails`, async () => {
    await assert.rejects(
      row(name),
      (error) => !String(error?.message).includes('is not in the source'),
      `the ${name} row passes without its check`
    );
  });
}
