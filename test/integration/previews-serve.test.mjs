import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { actPackage, boot, ready, run, shows } from './bios.mjs';
import { offered } from './catalog.mjs';
import { launch } from './chrome.mjs';
import { startServeHub } from './fake-serve-hub.mjs';

const chrome = await launch({ tools: false, timeout: 120000 });
after(() => chrome.close());

const SERVE = '@ai-ecoverse/slicc-serve';
const VERSION = await offered(SERVE);

const home = (page, name) =>
  page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    return dir.getFileHandle(name).then(
      async (handle) => (await handle.getFile()).text(),
      () => null
    );
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

test('serve from the catalog: its kernel server answers the serve hub over full HTTP with ranges, binary files, 404s and a body over 25 MiB', async (t) => {
  const hub = await startServeHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.serve-hub', url), hub.url);
  await page.reload();
  await ready(page, undefined, { tools: false });
  await page.until(() =>
    document
      .querySelector('slicc-app')
      .model.updates.packages()
      .some((item) => item.id === 'serve')
  );
  assert.equal(await actPackage(page, 'serve', 'install'), 'ok');
  await run(page, 'serve --version > /home/serve.version');
  assert.match(
    await until(() => home(page, 'serve.version'), 'serve --version'),
    new RegExp(VERSION.replaceAll('.', '\\.'))
  );

  await run(
    page,
    "mkdir -p /home/site/sub && printf '<h1>héllo</h1>' > /home/site/index.html && head -c 300000 /dev/urandom > /home/site/sub/blob.bin && head -c 26214401 /dev/zero > /home/site/huge.bin && echo site-ready"
  );
  await shows(page, 'site-ready');
  await run(page, '(serve --local /home/site > /home/serve.url 2>&1 &)');
  const local = (await until(() => home(page, 'serve.url'), 'serve --local')).trim();
  const port = Number(/^http:\/\/(\d+)\.kernel\.localhost/.exec(local)?.[1]);
  assert.ok(port > 0, local);

  await run(
    page,
    `{ exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"serve.publish","port":${port},"root":"~/site"}' >&3; head -n1 <&3 > /home/pub.json; cat <&3 > /dev/null; } &`
  );
  const { previewToken, url } = JSON.parse(
    await until(() => home(page, 'pub.json'), 'the publish')
  );
  assert.equal(url, `http://${previewToken}.localhost:${hub.port}/`);
  assert.deepEqual(hub.mints.at(-1).entry, '/');

  const index = await hub.visit(previewToken, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.body.toString(), '<h1>héllo</h1>');

  const blob = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
    const site = await (await dir.getDirectoryHandle('site')).getDirectoryHandle('sub');
    const bytes = new Uint8Array(
      await (await (await site.getFileHandle('blob.bin')).getFile()).arrayBuffer()
    );
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  });
  const expected = Buffer.from(blob, 'base64');
  const whole = await hub.visit(previewToken, '/sub/blob.bin');
  assert.equal(whole.status, 200);
  assert.ok(whole.body.equals(expected));

  const part = await hub.visit(previewToken, '/sub/blob.bin', {
    headers: { range: 'bytes=100-199' },
  });
  assert.deepEqual([part.status, part.headers['content-range']], [206, 'bytes 100-199/300000']);
  assert.ok(part.body.equals(expected.subarray(100, 200)));
  const tail = await hub.visit(previewToken, '/sub/blob.bin', { headers: { range: 'bytes=-10' } });
  assert.ok(tail.body.equals(expected.subarray(299990)));
  const beyond = await hub.visit(previewToken, '/sub/blob.bin', {
    headers: { range: 'bytes=400000-' },
  });
  assert.equal(beyond.status, 416);

  const missing = await hub.visit(previewToken, '/nope.html');
  assert.equal(missing.status, 404);
  const huge = await hub.visit(previewToken, '/huge.bin');
  assert.equal(huge.status, 200);
  assert.equal(huge.body.length, 26214401, 'a body over 25 MiB comes through whole');
  assert.ok(huge.body.every((byte) => byte === 0));
});
