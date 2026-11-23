import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startServeHub } from './fake-serve-hub.mjs';

const chrome = await launch({ tools: false });
const debug = () => {
  globalThis.sliccKernelDebug = true;
};
after(() => chrome.close());

const fixture = new URL('fixtures/httptest/', import.meta.url);

async function install(page) {
  const files = {
    'node_modules/httptest/package.json': (
      await readFile(new URL('package.json', fixture))
    ).toString('base64'),
    'node_modules/httptest/bin/httptest.wasm': (
      await readFile(new URL('bin/httptest.wasm', fixture))
    ).toString('base64'),
  };
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
      return { text: await (await (await dir.getFileHandle(name)).getFile()).text() };
    } catch (error) {
      return { text: null, error: error.name === 'NotFoundError' ? null : error.name };
    }
  }, name);

const home = async (page, name) => (await read(page, name)).text;

async function homeFile(page, name, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { text, error } = await read(page, name);
    if (text) return text;
    assert.ok(
      Date.now() < deadline,
      `no /home/${name} within ${ms} ms${error ? ` (reading it failed with ${error})` : ''}; the terminal shows: ${(await screen(page)).slice(-600)}`
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function until(check, what, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `${what} not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const hold = (name, header) =>
  `{ exec 3<>/dev/embedder; printf '%s\\n' '${JSON.stringify(header)}' >&3; head -n1 <&3 > /home/${name}.json 2> /home/${name}.err; cat <&3 > /home/${name}.rest; echo "ended $?" > /home/${name}.done; } & echo $! > /home/${name}.pid`;

const chips = (page) =>
  page.evaluate(() =>
    document
      .querySelector('slicc-app')
      .model.live.items()
      .filter((item) => item.kind === 'preview')
  );

const bootHub = async (page, hub, host) => {
  await page.evaluate(
    ([url, host]) => {
      localStorage.setItem('slicc-os.serve-hub', url);
      if (host) localStorage.setItem('slicc-os.serve-host', JSON.stringify(host));
    },
    [hub.url, host]
  );
  await page.reload();
  await ready(page, undefined, { tools: false });
};

test('serve.publish mints a live preview on the serve hub, relays full HTTP to the kernel server, and every way it ends revokes it', async (t) => {
  const hub = await startServeHub();
  t.after(() => hub.close());
  const made = await (await fetch(`${hub.url}/api/serve/host`, { method: 'POST' })).json();
  const orphan = hub.addPreview(made.hostId, { tag: '/srv/serve/orphan' });
  const kept = hub.addPreview(made.hostId, { tag: '/srv/serve/kept', ttlMs: 60_000 });
  const six = hub.addPreview(made.hostId, { tag: '/home/six' });
  const page = await chrome.page(t);
  await page.init(debug);
  await boot(page);
  await install(page);
  await bootHub(page, hub, made);
  await until(() => hub.stops.includes(orphan.previewToken), 'the orphan revoked at boot');
  assert.deepEqual(hub.stops, [orphan.previewToken]);
  assert.deepEqual([...hub.previews.keys()], [kept.previewToken, six.previewToken]);

  await run(page, 'httptest 8400 &');
  await shows(page, 'listening 8400');
  await run(
    page,
    hold('one', { kind: 'serve.publish', port: 8400, root: '~/demo', entry: 'file' })
  );
  const one = JSON.parse(await homeFile(page, 'one.json'));
  const minted = hub.mints.at(-1);
  assert.match(minted.tag, /^\/srv\/serve\/[0-9a-f]{32}$/);
  assert.deepEqual(minted, { entry: '/file', tag: minted.tag });
  assert.equal(hub.created, 1, 'the page keeps the host it has');
  const record = hub.previews.get(one.previewToken);
  assert.equal(record.hostId, made.hostId);
  assert.deepEqual(one, { url: record.url, previewToken: record.previewToken });
  assert.equal(one.url, `http://${one.previewToken}.localhost:${hub.port}/file`);
  const [chip] = await until(async () => (await chips(page)).length && chips(page), 'the chip');
  assert.deepEqual(
    [chip.label, chip.what, chip.asker, chip.action.label],
    ['Serving publicly', '~/demo', 'a terminal', 'Stop']
  );

  const file = await hub.visit(one.previewToken, '/file');
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'text/plain');
  assert.equal(file.body.toString(), 'hello from the kernel\n');
  const missing = await hub.visit(one.previewToken, '/nope');
  assert.equal(missing.status, 404);
  const sent = Buffer.alloc(300_000, 'a');
  const echoed = await hub.visit(one.previewToken, '/echo', { method: 'POST', body: sent });
  assert.equal(echoed.status, 200);
  assert.ok(echoed.body.equals(sent), 'a 300 000-byte POST body comes back whole');
  const events = await hub.visit(one.previewToken, '/events');
  assert.equal(events.headers['content-type'], 'text/event-stream');
  assert.equal(events.body.toString(), 'data: event 1\n\ndata: event 2\n\ndata: event 3\n\n');
  const request = hub.requests.find((r) => r.path === '/file');
  assert.equal(request.previewToken, one.previewToken);
  const stranger = hub.addPreview(made.hostId, { tag: '/srv/serve/stranger' });
  const unknown = await hub.visit(stranger.previewToken, '/file');
  assert.deepEqual(
    [unknown.status, unknown.body.toString()],
    [404, 'this preview is no longer served']
  );
  hub.previews.delete(stranger.previewToken);

  await run(
    page,
    'exec 4<>/dev/embedder; printf \'{"kind":"serve.list"}\\n\' >&4; cat <&4 > /home/list.txt; exec 4>&-'
  );
  const listed = (await homeFile(page, 'list.txt'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    listed.map(({ previewToken, url, root, port, entry }) => ({
      previewToken,
      url,
      root,
      port,
      entry,
    })),
    [{ previewToken: one.previewToken, url: one.url, root: '~/demo', port: 8400, entry: 'file' }]
  );

  await run(page, 'kill -- -$(cat /home/one.pid)');
  await until(
    () => hub.stops.includes(one.previewToken),
    'the preview revoked when its holder ends'
  );
  await until(async () => (await chips(page)).length === 0, 'the chip gone');
  const after = await hub.visit(one.previewToken, '/file');
  assert.equal(after.status, 404);

  await run(page, hold('two', { kind: 'serve.publish', port: 8400, root: '~/two', entry: 'file' }));
  const two = JSON.parse(await homeFile(page, 'two.json'));
  const [second] = await until(async () => (await chips(page)).length && chips(page), 'chip two');
  await page.evaluate((id) => document.querySelector('slicc-app').model.live.act(id), second.id);
  await until(() => hub.stops.includes(two.previewToken), 'Stop on the chip revokes');
  assert.equal((await homeFile(page, 'two.done')).trim(), 'ended 0');
  assert.deepEqual(JSON.parse(await homeFile(page, 'two.rest')), { stopped: 'stopped in seven' });

  await run(page, hold('three', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  const three = JSON.parse(await homeFile(page, 'three.json'));
  hub.revoke(three.previewToken);
  assert.equal((await homeFile(page, 'three.done')).trim(), 'ended 0');
  assert.deepEqual(JSON.parse(await homeFile(page, 'three.rest')), {
    stopped: 'revoked by the serve hub',
  });

  await run(page, hold('held', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  const held = JSON.parse(await homeFile(page, 'held.json'));
  const stop = JSON.stringify({ kind: 'serve.stop', previewToken: held.previewToken });
  await run(
    page,
    `printf '%s\\n' '{"kind":"serve.list"}' > /tmp/list.json; printf '%s\\n' '${stop}' > /tmp/stop.json; chmod 644 /tmp/list.json /tmp/stop.json; echo files-ready`
  );
  await shows(page, 'files-ready');
  const cone = await page.evaluate(async () => {
    const client = await globalThis.sliccRequestsClient();
    const run = (command) =>
      client.run(['sh', '-c', command], {
        user: 'cone',
        tag: '{"kind":"agent","agentId":"cone:cone"}',
      });
    try {
      const listed = await run('exec 4<>/dev/embedder; cat /tmp/list.json >&4; cat <&4 | wc -c');
      const stopped = await run('cat /tmp/stop.json > /dev/embedder');
      const text = (out) => (typeof out === 'string' ? out : new TextDecoder().decode(out));
      return {
        list: [listed.status, text(listed.stdout).trim()],
        stop: [stopped.status, text(stopped.stderr)],
      };
    } finally {
      await client.close();
    }
  });
  assert.deepEqual(cone.list, [0, '0'], JSON.stringify(cone));
  assert.notEqual(cone.stop[0], 0);
  assert.match(cone.stop[1], /the serve hub has no such preview/);
  assert.ok(!hub.stops.includes(held.previewToken), "a cone can't stop root's preview");
  await run(page, 'cat /tmp/stop.json > /dev/embedder; echo "root-stop-$?-$((40 + 2))"');
  await shows(page, 'root-stop-0-42');
  assert.ok(hub.stops.includes(held.previewToken));
  assert.deepEqual(JSON.parse(await homeFile(page, 'held.rest')), {
    stopped: 'stopped with serve --stop',
  });

  hub.mintFails = [400, { error: 'entry must start with /', code: 'BAD_REQUEST' }];
  await run(page, hold('refused', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  assert.deepEqual(JSON.parse(await homeFile(page, 'refused.json')), {
    error: 'entry must start with /',
    status: 400,
    code: 'BAD_REQUEST',
  });
  assert.equal((await homeFile(page, 'refused.done')).trim(), 'ended 0');
  hub.mintFails = null;

  await run(page, hold('lost', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  JSON.parse(await homeFile(page, 'lost.json'));
  hub.deleteHost(made.hostId);
  assert.deepEqual(JSON.parse(await homeFile(page, 'lost.rest')), {
    stopped: 'seven lost its serve host',
  });
  await until(() => hub.created === 2, 'a new host once the old one is deleted');
  const fresh = [...hub.hosts.keys()].at(-1);
  await run(page, hold('four', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  const four = JSON.parse(await homeFile(page, 'four.json'));
  assert.equal(hub.previews.get(four.previewToken).hostId, fresh);
  assert.equal((await hub.visit(four.previewToken, '/file')).status, 200);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('previews', false)
  );
  await until(() => hub.stops.includes(four.previewToken), 'the switch revokes');
  assert.deepEqual(JSON.parse(await homeFile(page, 'four.rest')), {
    stopped: 'public previews were switched off',
  });
  const minting = hub.mints.length;
  await run(page, hold('five', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  assert.equal((await homeFile(page, 'five.done')).trim(), 'ended 1');
  assert.equal(await home(page, 'five.json'), '');
  assert.match(await home(page, 'five.err'), /public previews are off in seven's settings/);
  assert.equal(hub.mints.length, minting);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('previews', true)
  );

  await run(page, hold('six', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  const last = JSON.parse(await homeFile(page, 'six.json'));
  const stopsBefore = hub.stops.length;
  await page.reload();
  await ready(page, undefined, { tools: false });
  await until(
    () => hub.stops.slice(stopsBefore).includes(last.previewToken),
    'revoked after a reload'
  );
});

test('a seven without a serve hub refuses serve.publish with ENOTSUP', async (t) => {
  const page = await chrome.page(t);
  await page.init(debug);
  await boot(page);
  await install(page);
  await run(page, hold('none', { kind: 'serve.publish', port: 8400 }));
  assert.equal((await homeFile(page, 'none.done')).trim(), 'ended 1');
  assert.match(
    await home(page, 'none.err'),
    /seven publishes previews only through the serve hub, and it has none here/
  );
});
