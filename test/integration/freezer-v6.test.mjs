import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { agentUp, ready } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';

const chrome = await launch({ tools: false, agent: true, timeout: 60000 });
const seven = new URL(chrome.url);
const www = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://www');
  if (url.pathname === '/7') return response.writeHead(301, { location: '/7/' }).end();
  if (url.pathname.startsWith('/7/') || url.pathname.startsWith('/fonts/')) {
    const path = url.pathname.startsWith('/7/') ? url.pathname.slice(2) : url.pathname;
    const upstream = await fetch(new URL(`${path}${url.search}`, seven));
    const headers = Object.fromEntries(
      [...upstream.headers].filter(
        ([name]) => !['content-encoding', 'transfer-encoding'].includes(name)
      )
    );
    if (url.pathname === '/7/sw.js') headers['service-worker-allowed'] = '/';
    return response
      .writeHead(upstream.status, headers)
      .end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (url.pathname.startsWith('/os/'))
    return request.headers['sec-fetch-mode'] === 'navigate'
      ? response.writeHead(302, { location: '/7/' }).end()
      : response.writeHead(404).end();
  response.writeHead(404).end();
});
await new Promise((done) => www.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${www.address().port}`;
after(async () => {
  await new Promise((done) => {
    www.close(done);
    www.closeAllConnections();
  });
  await chrome.close();
});

const NOTES = 'harbor notes from SLICC 6\n';

async function plant(page, id, files) {
  return page.evaluate(
    async ({ id, files, notes }) => {
      const dir = async (path) => {
        let at = await navigator.storage.getDirectory();
        for (const part of path.split('/').filter(Boolean))
          at = await at.getDirectoryHandle(part, { create: true });
        return at;
      };
      const write = async (path, text) => {
        const parts = path.split('/').filter(Boolean);
        const name = parts.pop();
        const writable = await (
          await (await dir(parts.join('/'))).getFileHandle(name, { create: true })
        ).createWritable();
        await writable.write(text);
        await writable.close();
      };
      const bytes = new TextEncoder().encode(notes);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      await write('slicc-fs/home/user/notes.txt', notes);
      const manifest = {
        format: 'slicc-profile',
        version: 2,
        exportId: id,
        producer: { slicc: '6.99.0', origin: location.origin },
        createdAt: '2026-10-19T12:00:00.000Z',
        licks: null,
        gitconfig: null,
        cones: [],
        frozen: [],
        skills: [],
        sprinkles: [],
        files: files.map((file) => ({ size: bytes.length, sha256, ...file })),
        skipped: [],
        flagged: [],
      };
      await write(`slicc-v6-upgrade/${id}/manifest.json`, JSON.stringify(manifest));
      return `/slicc-v6-upgrade/${id}`;
    },
    { id, files, notes: NOTES }
  );
}

const sh = (page, command) =>
  page.evaluate(async (command) => {
    const client = await globalThis.sliccKernelClient();
    const { status, stdout, stderr } = await client.run(['bash', '-c', command], { cwd: '/root' });
    return { status, out: `${stdout}${stderr}` };
  }, command);

test('slicc-agent#487: on a /7/ boot, freezer import --in-place refuses a .. path and moves a directory form without providers out of /slicc-fs', {
  timeout: 30 * 60 * 1000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(
    `() => { globalThis.sliccKernelDebug = true; if (location.origin === ${JSON.stringify(origin)} && !localStorage.getItem(${JSON.stringify(VAULT_KEY)})) localStorage.setItem(${JSON.stringify(VAULT_KEY)}, ${JSON.stringify(chrome.vault.origin)}); }`
  );
  await page.goto(`${origin}/7/`);
  await ready(page);
  await agentUp(page);

  const refused = await plant(page, '00000000-0000-4000-8000-000000000001', [
    { path: 'files/home-user/../../../etc/notes.txt', source: '/slicc-fs/home/user/notes.txt' },
  ]);
  const climbed = await sh(page, `freezer import --in-place ${refused}`);
  assert.match(
    climbed.out,
    /refused the entry name "files\/home-user\/\.\.\/\.\.\/\.\.\/etc\/notes\.txt"/,
    climbed.out
  );
  const escaped = await plant(page, '00000000-0000-4000-8000-000000000002', [
    { path: 'files/home-user/notes.txt', source: '/slicc-fs/../etc/notes.txt' },
  ]);
  const out = await sh(page, `freezer import --in-place ${escaped}`);
  assert.match(out.out, /source must be a path under \/slicc-fs\//, out.out);
  const kept = await sh(
    page,
    'cat /slicc-fs/home/user/notes.txt; test ! -e /etc/notes.txt && test ! -e /root/v6 && echo nothing-moved'
  );
  assert.equal(kept.out, `${NOTES}nothing-moved\n`, kept.out);

  const upgrade = await plant(page, '00000000-0000-4000-8000-000000000003', [
    { path: 'files/home-user/notes.txt', source: '/slicc-fs/home/user/notes.txt' },
  ]);
  const previewed = await sh(page, `freezer import --in-place --preview ${upgrade}`);
  assert.equal(previewed.status, 0, previewed.out);
  assert.match(previewed.out, /SLICC 6 profile from /, previewed.out);
  const imported = await sh(page, `freezer import --in-place ${upgrade}`);
  assert.equal(imported.status, 0, imported.out);
  assert.match(imported.out, /Imported 0 frozen cones/, imported.out);
  const moved = await sh(
    page,
    `cat /root/v6/home-user/notes.txt; test ! -e /slicc-fs/home/user/notes.txt && echo gone-from-slicc-fs; test ! -e ${upgrade} && echo upgrade-dir-removed`
  );
  assert.equal(moved.out, `${NOTES}gone-from-slicc-fs\nupgrade-dir-removed\n`, moved.out);
  assert.deepEqual(page.errors, []);
});
