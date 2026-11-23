import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { boot, ready, run, screen, shows } from './bios.mjs';
import { launch } from './chrome.mjs';
import { startServeHub } from './fake-serve-hub.mjs';

const chrome = await launch({ tools: false });
const debug = () => {
  globalThis.sliccKernelDebug = true;
};

const running = (page, pgid) =>
  page.evaluate(async (pgid) => {
    const client = await globalThis.sliccKernelClient();
    try {
      return (await client.ps()).some((entry) => entry.pgid === pgid && entry.state !== 'Z');
    } finally {
      await client.close();
    }
  }, pgid);
after(() => chrome.close());

const read = (page, name) =>
  page.evaluate(async (name) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('home');
      return { text: await (await (await dir.getFileHandle(name)).getFile()).text() };
    } catch (error) {
      return { text: null, error: error.name === 'NotFoundError' ? null : error.name };
    }
  }, name);

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

const binary = Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 37) % 256));
const FILES = [
  { path: 'index.html', type: 'text/html; charset=utf-8', bytes: Buffer.from('<h1>snapshot</h1>') },
  { path: 'css/a.css', type: 'text/css; charset=utf-8', bytes: Buffer.from('h1{color:red}') },
  { path: 'img/blob.bin', type: 'application/octet-stream', bytes: binary },
];

function snapshotBody(files, header = {}) {
  const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
  const parts = [
    Buffer.from(
      `${JSON.stringify({ kind: 'serve.snapshot', root: '/home/site', ttlMs: 3600000, files: files.length, bytes, ...header })}\n`
    ),
  ];
  for (const file of files)
    parts.push(
      Buffer.from(
        `${JSON.stringify({ path: file.path, type: file.type, size: file.bytes.length })}\n`
      ),
      file.bytes
    );
  return Buffer.concat(parts);
}

async function ask(page, name, body) {
  const b64 = body.toString('base64');
  const lines = b64.match(/.{1,4000}/g);
  await run(page, `rm -f /home/${name}.b64; echo staging-${name}`);
  await shows(page, `staging-${name}`);
  for (const [index, chunk] of lines.entries()) {
    await run(page, `printf '%s' '${chunk}' >> /home/${name}.b64; echo part-${name}-${index}`);
    await shows(page, `part-${name}-${index}`);
  }
  await run(
    page,
    `base64 -d /home/${name}.b64 > /tmp/${name}.body && { exec 3<>/dev/embedder; cat /tmp/${name}.body >&3; head -n1 <&3 > /home/${name}.json 2> /home/${name}.err; echo "ended-$?" > /home/${name}.done; exec 3>&-; }`
  );
  return (await homeFile(page, `${name}.done`)).trim();
}

test('serve.snapshot mints a snapshot on the serve hub, uploads the body’s files with the host’s bearer, finalizes it, and keeps it for serve.list and serve.stop across a reload', async (t) => {
  const hub = await startServeHub();
  t.after(() => hub.close());
  const page = await chrome.page(t);
  await page.init(debug);
  await boot(page);
  await page.evaluate((url) => localStorage.setItem('slicc-os.serve-hub', url), hub.url);
  await page.reload();
  await ready(page, undefined, { tools: false });
  assert.equal(await ask(page, 'one', snapshotBody(FILES)), 'ended-0');
  const one = JSON.parse(await homeFile(page, 'one.json'));
  const minted = hub.mints.at(-1);
  assert.match(minted.tag, /^\/srv\/serve\/[0-9a-f]{32}$/);
  assert.deepEqual(minted, { entry: '/', tag: minted.tag, ttlMs: 3600000 });
  assert.equal(one.url, `http://${one.previewToken}.localhost:${hub.port}/`);
  assert.equal('trayId' in one, false);
  const host = JSON.parse(await page.evaluate(() => localStorage.getItem('slicc-os.serve-host')));
  assert.deepEqual([one.files, one.bytes], [3, FILES.reduce((n, f) => n + f.bytes.length, 0)]);
  assert.ok(one.expiresAt > Date.now() + 3500000 && one.expiresAt <= Date.now() + 3600000);
  assert.deepEqual(hub.uploads.map((upload) => upload.path).sort(), [
    'css/a.css',
    'img/blob.bin',
    'index.html',
  ]);
  assert.ok(hub.uploads.every((upload) => upload.authorization === `Bearer ${host.secret}`));
  for (const file of FILES) {
    const got = await hub.visit(one.previewToken, `/${file.path}`);
    assert.equal(got.status, 200, file.path);
    assert.equal(got.headers['content-type'], file.type, file.path);
    assert.ok(got.body.equals(file.bytes), file.path);
  }
  assert.equal((await hub.visit(one.previewToken, '/')).body.toString(), '<h1>snapshot</h1>');

  await run(
    page,
    'exec 4<>/dev/embedder; printf \'{"kind":"serve.list"}\\n\' >&4; cat <&4 > /home/list.txt; exec 4>&-'
  );
  const listed = JSON.parse((await homeFile(page, 'list.txt')).trim());
  assert.deepEqual(
    { ...listed, since: 0 },
    {
      previewToken: one.previewToken,
      url: one.url,
      root: '/home/site',
      since: 0,
      mode: 'persistent',
      expiresAt: one.expiresAt,
    }
  );

  const orphan = hub.addPreview(host.hostId, { tag: '/srv/serve/orphan' });
  await page.reload();
  await ready(page, undefined, { tools: false });
  await until(() => hub.stops?.includes(orphan.previewToken), 'the boot sweep');
  assert.equal(hub.stops.includes(one.previewToken), false, 'the sweep left the snapshot alone');
  await run(
    page,
    'exec 4<>/dev/embedder; printf \'{"kind":"serve.list"}\\n\' >&4; cat <&4 > /home/list2.txt; exec 4>&-'
  );
  assert.match(await homeFile(page, 'list2.txt'), new RegExp(one.previewToken));

  hub.uploadFails = (path) =>
    path === 'css/a.css' ? [413, { error: 'too big', code: 'FILE_TOO_LARGE' }] : null;
  let before = hub.stops.length;
  assert.equal(await ask(page, 'two', snapshotBody(FILES)), 'ended-0');
  const two = JSON.parse(await homeFile(page, 'two.json'));
  assert.deepEqual(two, {
    error: 'too big',
    status: 413,
    code: 'FILE_TOO_LARGE',
    during: 'upload',
    path: 'css/a.css',
  });
  await until(() => hub.stops.length > before, 'the refused snapshot stopped');
  assert.notEqual(hub.stops.at(-1), one.previewToken);
  hub.uploadFails = null;
  before = hub.stops.length;
  assert.equal(await ask(page, 'three', snapshotBody(FILES, { bytes: 5 })), 'ended-1');
  assert.match(
    await homeFile(page, 'three.err'),
    /bad snapshot body: more than the 5 bytes it announced/
  );
  await until(() => hub.stops.length > before, 'the bad snapshot stopped');
  hub.mintFails = [400, { error: 'ttlMs is out of range', code: 'BAD_REQUEST' }];
  assert.equal(await ask(page, 'four', snapshotBody(FILES)), 'ended-0');
  assert.deepEqual(JSON.parse(await homeFile(page, 'four.json')), {
    error: 'ttlMs is out of range',
    status: 400,
    code: 'BAD_REQUEST',
    during: 'mint',
  });
  hub.mintFails = null;

  let release;
  let finalizing = null;
  hub.holdFinalize = (record) => {
    finalizing = record.previewToken;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const held = snapshotBody(FILES.slice(0, 1)).toString('base64');
  await run(
    page,
    `printf '%s' '${held}' | base64 -d > /tmp/held.body; (exec 3<>/dev/embedder; cat /tmp/held.body >&3; head -n1 <&3) > /home/held.json & echo $! > /home/held.pid`
  );
  await until(() => finalizing, 'the finalize held');
  const group = Number((await homeFile(page, 'held.pid')).trim());
  assert.equal(await running(page, group), true);
  await run(page, 'kill -- -$(cat /home/held.pid); echo killed-$((40 + 2))');
  await shows(page, 'killed-42');
  await until(async () => !(await running(page, group)), 'the killed program gone from ps');
  release();
  hub.holdFinalize = null;
  await until(
    () => hub.stops?.includes(finalizing),
    'a snapshot cancelled during finalize stopped'
  );
  assert.ok(
    !(await page.evaluate(() => localStorage.getItem('slicc-os.snapshots') ?? '')).includes(
      finalizing
    )
  );

  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('previews', false)
  );
  assert.equal(await ask(page, 'five', snapshotBody(FILES)), 'ended-1');
  assert.match(await homeFile(page, 'five.err'), /public previews are off in seven's settings/);
  await page.evaluate(() =>
    document.querySelector('slicc-app').model.switches.set('previews', true)
  );

  const stop = `printf '%s\\n' '{"kind":"serve.stop","previewToken":"${one.previewToken}"}' | cat > /dev/embedder`;
  hub.stopFails = [503, { error: 'the hub is down' }];
  await run(page, `${stop}; echo "failed-stop-$?-$((40 + 2))"`);
  await shows(page, 'failed-stop-1-42');
  assert.ok(hub.previews.has(one.previewToken), 'the hub still serves it');
  await run(
    page,
    'exec 4<>/dev/embedder; printf \'{"kind":"serve.list"}\\n\' >&4; cat <&4 > /home/list-kept.txt; exec 4>&-'
  );
  assert.equal(
    JSON.parse((await homeFile(page, 'list-kept.txt')).trim()).previewToken,
    one.previewToken,
    'a stop the hub failed keeps the snapshot'
  );
  hub.stopFails = null;
  await run(page, `${stop}; echo "stop-$?-$((40 + 2))"`);
  await shows(page, 'stop-0-42');
  assert.ok(hub.stops.includes(one.previewToken));
  assert.equal((await hub.visit(one.previewToken, '/')).status, 404);
  await run(
    page,
    'exec 4<>/dev/embedder; printf \'{"kind":"serve.list"}\\n\' >&4; cat <&4 > /home/list3.txt; echo "listed-$?" >> /home/list3.txt; exec 4>&-'
  );
  assert.equal((await homeFile(page, 'list3.txt')).trim(), 'listed-0');
  assert.equal(await page.evaluate(() => localStorage.getItem('slicc-os.snapshots')), '[]');
});
