import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startServeHub } from './fake-serve-hub.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const fixture = new URL('fixtures/relay-fixture/', import.meta.url);
const PORT = 8490;

async function install(page) {
  const files = {};
  for (const name of ['package.json', 'index.mjs'])
    files[`node_modules/relay-fixture/${name}`] = (await readFile(new URL(name, fixture))).toString(
      'base64'
    );
  await page.evaluate(async (files) => {
    for (const [path, data] of Object.entries(files)) {
      const names = path.split('/');
      const name = names.pop();
      let dir = await navigator.storage.getDirectory();
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      await writable.close();
    }
  }, files);
}

const read = (page, name) =>
  page.evaluate(async (name) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }, name);

async function until(check, what, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `${what} not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function published(t) {
  const hub = await startServeHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  await boot(page);
  await install(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.serve-hub', url), hub.url);
  await page.reload();
  await ready(page, undefined, { tools: false });
  await run(page, `relay-fixture ${PORT} &`);
  await shows(page, `listening ${PORT}`);
  const publish = JSON.stringify({ kind: 'serve.publish', port: PORT });
  await run(
    page,
    `{ exec 3<>/dev/embedder; printf '%s\\n' '${publish}' >&3; head -n1 <&3 > /home/pub.json; cat <&3 > /dev/null; } & echo $! > /home/pub.pid`
  );
  const line = await until(() => read(page, 'pub.json'), 'the publish');
  const { previewToken } = JSON.parse(line);
  await run(
    page,
    `{ exec 4<>/dev/embedder; printf '%s\\n' '${publish}' >&4; head -n1 <&4 > /home/counter.json; cat <&4 > /dev/null; } &`
  );
  const counter = JSON.parse(await until(() => read(page, 'counter.json'), 'the counter'));
  const count = async () =>
    JSON.parse((await hub.visit(counter.previewToken, '/count')).body.toString());
  return { hub, page, token: previewToken, count };
}

test('the relay passes cookies, every Set-Cookie, the method, query and body through, keeps redirects on the preview, and sets the forwarding headers from the minted host', async (t) => {
  const { hub, token } = await published(t);
  const got = await hub.visit(token, '/echo?x=1&y=%2F', {
    method: 'POST',
    headers: { cookie: 'a=1; b=2', 'content-type': 'text/plain', 'x-forwarded-host': 'evil' },
    body: 'hello body',
  });
  assert.equal(got.status, 200);
  assert.deepEqual(got.headers['set-cookie'], ['a=1; Path=/', 'b=2; HttpOnly']);
  const echo = JSON.parse(got.body.toString());
  assert.deepEqual(
    [echo.method, echo.target, echo.body, echo.extra],
    ['POST', '/echo?x=1&y=%2F', 'hello body', 0]
  );
  assert.equal(echo.headers.cookie, 'a=1; b=2');
  assert.equal(echo.headers.host, `127.0.0.1:${PORT}`);
  assert.equal(echo.headers['x-forwarded-host'], `${token}.localhost:${hub.port}`);
  assert.equal(echo.headers['x-forwarded-proto'], 'https');
  const spoofed = await hub.inject(token, {
    path: '/echo',
    url: 'https://attacker.example/echo',
  });
  assert.equal(
    JSON.parse(spoofed.body.toString()).headers['x-forwarded-host'],
    `${token}.localhost:${hub.port}`,
    "the forwarded host is the minted one, not the request's"
  );
  const moved = await hub.visit(token, '/redirect');
  assert.deepEqual([moved.status, moved.headers.location], [302, '/landed?from=1']);
  const away = await hub.visit(token, '/elsewhere');
  assert.equal(away.headers.location, 'http://example.com/x');
});

test('the relay refuses malformed, CONNECT, TRACE and unknown requests without dialing, and sends a body only up to its Content-Length', async (t) => {
  const { hub, token, count } = await published(t);
  const before = (await count()).connections;
  const status = async (token, fields) => (await hub.inject(token, fields)).status;
  assert.equal(await status(token, { method: 'G ET' }), 400);
  assert.equal(await status(token, { path: 'nope' }), 400);
  assert.equal(await status(token, { headers: [['content-length', 'x']] }), 400);
  assert.equal(await status(token, { method: 'CONNECT' }), 405);
  assert.equal(await status(token, { method: 'TRACE' }), 405);
  const stranger = hub.addPreview(hub.current.hostId, { tag: '/srv/serve/stranger' });
  assert.equal(await status(stranger.previewToken, {}), 404);
  assert.equal(await status(token, { port: 22, host: '10.0.0.1', path: '/count' }), 200);
  assert.equal(
    (await count()).connections,
    before + 2,
    'only the two requests that reach the port dial it'
  );
  const smuggled = await hub.inject(
    token,
    { method: 'POST', path: '/echo', headers: [['content-length', '3']] },
    ['abcGET /count HTTP/1.1\r\nHost: x\r\n\r\n']
  );
  const echo = JSON.parse(smuggled.body.toString());
  assert.deepEqual(
    [echo.body, echo.extra],
    ['abc', 0],
    'nothing past Content-Length reaches the port'
  );
});

test('the relay answers 504 when the port sends no head, cancels a stream idle for 25 s, keeps one that keeps sending, and caps the streams of a preview at 16', async (t) => {
  const { hub, token, count, page } = await published(t);
  const before = (await count()).connections;
  const silent = Array.from({ length: 16 }, () => hub.visit(token, '/silent'));
  await until(async () => (await count()).connections >= before + 17, 'sixteen held streams');
  const held = (await count()).connections;
  const over = await hub.visit(token, '/count');
  assert.equal(over.status, 503, 'the seventeenth stream of a preview is refused');
  assert.equal(over.headers['retry-after'], '1');
  assert.equal((await count()).connections, held + 1, 'and dials nothing');
  const answers = await Promise.all(silent);
  assert.deepEqual(new Set(answers.map((a) => a.status)), new Set([504]));
  assert.match(answers[0].body.toString(), /didn't answer within 25 s/);
  await until(async () => (await count()).closed.silent === 16, 'every silent connection closed');

  const stalled = hub.visit(token, '/stall');
  const dripping = hub.visit(token, '/drip?n=70&ms=500');
  const stall = await stalled;
  assert.equal(stall.status, 200);
  assert.ok(stall.broken, 'a stream idle for 25 s is cut');
  assert.ok(hub.cancels.some((c) => /sent nothing for 25 s/.test(c.reason)));
  await until(async () => (await count()).closed.stall === 1, 'the stalled connection closed');
  const drip = await dripping;
  assert.equal(
    drip.broken,
    false,
    `a stream that keeps sending for 35 s stays: ${(await screen(page)).slice(-200)}`
  );
  assert.equal((drip.body.toString().match(/data: /g) ?? []).length, 70);
});

test('an answer of 70 MiB streams through to a slow visitor with at most 1 MiB unacknowledged, and unpublishing closes the streams to the port', async (t) => {
  const { hub, token, count, page } = await published(t);
  const size = 70 * 1024 * 1024;
  const big = await hub.visit(token, `/big?n=${size}`, { pauseMs: 3000 });
  assert.equal(big.status, 200);
  assert.equal(big.body.length, size);
  assert.ok(hub.maxUnacked <= 1024 * 1024, `unacknowledged bytes peaked at ${hub.maxUnacked}`);

  const held = hub.visit(token, '/stall');
  await until(() => hub.streams.size > 0, 'the stalled stream');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const started = Date.now();
  await run(page, 'kill -- -$(cat /home/pub.pid)');
  const ended = await held;
  assert.ok(ended.broken, 'the stream ends with its preview');
  assert.ok(Date.now() - started < 15000, 'well before the idle bound');
  assert.ok(hub.cancels.some((c) => c.reason === 'this preview is no longer served'));
});
