import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startHub } from './fake-hub.mjs';

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

test('serve.publish mints a live preview, the tray relays preview.request to the kernel server, and every way it ends revokes it', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  await page.init(debug);
  await boot(page);
  await install(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.tray-hub', url), hub.url);
  await page.reload();
  await ready(page, undefined, { tools: false });
  await page.until(() => document.querySelector('slicc-app').model.network.status().links?.joinUrl);
  hub.addPreview('1', {
    servedRoot: '/srv/serve/orphan',
    entryPath: '/srv/serve/orphan/index.html',
  });
  hub.addPreview(
    '1',
    { servedRoot: '/srv/serve/kept', entryPath: '/srv/serve/kept/index.html' },
    {
      mode: 'persistent',
    }
  );
  hub.addPreview('1', { servedRoot: '/home/six', entryPath: '/home/six/index.html' });
  hub.send({ type: 'leader.connected', trayId: 't1', controllerId: 'leader' });
  await until(() => hub.stops?.includes('t1.p1'), 'the orphan revoked');
  assert.deepEqual(hub.stops, ['t1.p1']);
  assert.deepEqual([...hub.previews.keys()], ['t1.p2', 't1.p3']);

  await run(page, 'httptest 8400 &');
  await shows(page, 'listening 8400');
  await run(
    page,
    hold('one', { kind: 'serve.publish', port: 8400, root: '~/demo', entry: 'file' })
  );
  const one = JSON.parse(await homeFile(page, 'one.json'));
  const minted = hub.minting.at(-1);
  assert.match(minted.servedRoot, /^\/srv\/serve\/[0-9a-f]{32}$/);
  assert.deepEqual(minted, {
    servedRoot: minted.servedRoot,
    entryPath: `${minted.servedRoot}/file`,
    allowLive: true,
  });
  assert.deepEqual(one, {
    url: 'http://p4.preview.test/file',
    previewToken: 't1.p4',
    trayId: 't1',
  });
  const [chip] = await until(async () => (await chips(page)).length && chips(page), 'the chip');
  assert.deepEqual(
    [chip.label, chip.what, chip.asker, chip.action.label],
    ['Serving publicly', '~/demo', 'a terminal', 'Stop']
  );

  const file = await hub.visit('t1.p4', '/');
  assert.equal(file.ok, true);
  assert.equal(file.status, 200);
  assert.equal(file.mime, 'text/plain');
  assert.match(file.body.toString(), /\S/);
  assert.equal(file.size, file.body.length);
  const missing = await hub.visit('t1.p4', '/nope');
  assert.deepEqual([missing.ok, missing.status], [false, 404]);
  const escaped = await hub.ask('1', {
    servedRoot: minted.servedRoot,
    vfsPath: `${minted.servedRoot}/../../etc/passwd`,
    asText: true,
  });
  assert.deepEqual([escaped.ok, escaped.status], [false, 403]);
  const unknown = await hub.ask('1', {
    servedRoot: '/srv/serve/unknown',
    vfsPath: '/srv/serve/unknown/index.html',
    asText: true,
  });
  assert.deepEqual([unknown.status, unknown.reason], [404, 'this preview is no longer served']);

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
    [
      {
        previewToken: 't1.p4',
        url: 'http://p4.preview.test/file',
        root: '~/demo',
        port: 8400,
        entry: 'file',
      },
    ]
  );

  await run(page, 'kill -- -$(cat /home/one.pid)');
  await until(() => hub.stops.includes('t1.p4'), 'the preview revoked when its holder ends');
  await until(async () => (await chips(page)).length === 0, 'the chip gone');
  const after = await hub.visit('t1.p4', '/');
  assert.deepEqual([after.ok, after.status], [false, 404]);

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
    stopped: 'revoked by the tray hub',
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
  assert.match(cone.stop[1], /the tray hub has no such preview/);
  assert.ok(!hub.stops.includes(held.previewToken), "a cone can't stop root's preview");
  await run(page, 'cat /tmp/stop.json > /dev/embedder; echo "root-stop-$?-$((40 + 2))"');
  await shows(page, 'root-stop-0-42');
  assert.ok(hub.stops.includes(held.previewToken));
  assert.deepEqual(JSON.parse(await homeFile(page, 'held.rest')), {
    stopped: 'stopped with serve --stop',
  });

  hub.mintFails = [429, { error: 'Too many live previews', code: 'LIVE_PREVIEW_LIMIT' }];
  await run(page, hold('limited', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  assert.deepEqual(JSON.parse(await homeFile(page, 'limited.json')), {
    error: 'Too many live previews',
    status: 429,
    code: 'LIVE_PREVIEW_LIMIT',
  });
  assert.equal((await homeFile(page, 'limited.done')).trim(), 'ended 0');
  hub.mintFails = null;

  await run(page, hold('four', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  const four = JSON.parse(await homeFile(page, 'four.json'));
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('previews', false)
  );
  await until(() => hub.stops.includes(four.previewToken), 'the switch revokes');
  assert.deepEqual(JSON.parse(await homeFile(page, 'four.rest')), {
    stopped: 'public previews were switched off',
  });
  const minting = hub.minting.length;
  await run(page, hold('five', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  assert.equal((await homeFile(page, 'five.done')).trim(), 'ended 1');
  assert.equal(await home(page, 'five.json'), '');
  assert.match(await home(page, 'five.err'), /public previews are off in seven's settings/);
  assert.equal(hub.minting.length, minting);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('previews', true)
  );

  await run(page, hold('six', { kind: 'serve.publish', port: 8400, entry: 'file' }));
  const six = JSON.parse(await homeFile(page, 'six.json'));
  const stopsBefore = hub.stops.length;
  await page.reload();
  await ready(page, undefined, { tools: false });
  await until(
    () => hub.stops.slice(stopsBefore).includes(six.previewToken),
    'revoked after a reload'
  );
  assert.ok(hub.previews.has('t1.p2'), 'a persistent preview stays');
  assert.ok(hub.previews.has('t1.p3'), "a preview outside /srv/serve/ isn't seven's to revoke");
});
