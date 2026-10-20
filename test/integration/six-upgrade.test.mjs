import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { booted, ready, watch } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';
import {
  exporterPage,
  exporterScript,
  previewWorker,
  STOP_ERROR,
  sixPage,
  spoofPage,
} from './fake-six.mjs';

const chrome = await launch();
const seven = new URL(chrome.url);
let mode = 'ok';
let isolate = false;
const asked = [];
const www = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://www');
  asked.push(url.pathname);
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
    if (isolate && headers['content-type']?.startsWith('text/html')) {
      headers['cross-origin-opener-policy'] = 'same-origin';
      headers['cross-origin-embedder-policy'] = 'require-corp';
    }
    return response
      .writeHead(upstream.status, headers)
      .end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (url.pathname.startsWith('/os/')) {
    return request.headers['sec-fetch-mode'] === 'navigate'
      ? response.writeHead(302, { location: '/7/' }).end()
      : response.writeHead(404).end();
  }
  const html = { 'content-type': 'text/html; charset=utf-8' };
  const js = { 'content-type': 'text/javascript; charset=utf-8' };
  const corp = {
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
  };
  const framed = {
    ...corp,
    'content-security-policy': "frame-ancestors 'self'",
    'x-frame-options': 'SAMEORIGIN',
    'cache-control': 'no-store',
  };
  if (url.pathname === '/') return response.writeHead(200, html).end(sixPage);
  if (url.pathname === '/preview-sw.js') return response.writeHead(200, js).end(previewWorker);
  if (url.pathname === '/spoof.html') {
    return response
      .writeHead(200, {
        ...html,
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'cross-origin',
      })
      .end(spoofPage);
  }
  if (url.pathname === '/upgrade-to-seven.html') {
    return response.writeHead(200, { ...html, ...framed }).end(exporterPage);
  }
  if (url.pathname === '/assets/upgrade-to-seven-f1x7.js') {
    return response
      .writeHead(200, { ...js, ...corp, 'cache-control': 'no-store' })
      .end(exporterScript(mode, foreign));
  }
  response.writeHead(404).end();
});
await new Promise((done) => www.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${www.address().port}`;
const foreign = `http://localhost:${www.address().port}`;
after(async () => {
  await new Promise((done) => {
    www.close(done);
    www.closeAllConnections();
  });
  await chrome.close();
});

async function open(t) {
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(origin)} && !localStorage.getItem(${JSON.stringify(VAULT_KEY)})) localStorage.setItem(${JSON.stringify(VAULT_KEY)}, ${JSON.stringify(chrome.vault.origin)}); }`
  );
  return page;
}

async function dialog(page) {
  const seen = [];
  await page.expose('six', (event) => seen.push(event));
  await page.init(() => {
    if (!location.pathname.startsWith('/7/')) return;
    const tell = (event) => window.six(JSON.stringify(event));
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node.classList?.contains('six-exporter')) {
            tell({
              type: 'removed',
              marker: localStorage.getItem('slicc-os.six'),
              pending: localStorage.getItem('slicc-os.six-import'),
            });
          }
        }
        for (const node of record.addedNodes) {
          if (node.classList?.contains('six-exporter')) tell({ type: 'framed', src: node.src });
        }
        const box = record.target.closest?.('.six');
        if (!box) continue;
        if (record.type === 'attributes' && record.attributeName === 'data-state') {
          tell({ type: 'state', state: box.dataset.state });
        }
        const line = box.querySelector('.six-progress');
        if (record.type === 'childList' && record.target === line) {
          tell({ type: 'progress', text: line.textContent });
        }
      }
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
  });
  return {
    states: () => seen.filter((event) => event.type === 'state').map((event) => event.state),
    progress: () => seen.filter((event) => event.type === 'progress').map((event) => event.text),
    removed: () => seen.filter((event) => event.type === 'removed'),
    framed: () => seen.filter((event) => event.type === 'framed'),
  };
}

async function runSix(page) {
  await page.goto(`${origin}/`);
  await page.until(() => document.getElementById('six')?.dataset.ran === 'yes');
}

function previews(page) {
  return page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations())
      .map((registration) => new URL(registration.scope).pathname)
      .filter((scope) => scope.startsWith('/preview/'))
  );
}

function showing(page, state) {
  return page.until(
    (state) =>
      document.querySelector('.six')?.dataset.state === state &&
      !document.querySelector('.six').hidden &&
      [...document.querySelectorAll('.six .chip')].some((chip) => !chip.hidden),
    state
  );
}

const storage = (page) =>
  page.evaluate(() => ({
    marker: localStorage.getItem('slicc-os.six'),
    pending: localStorage.getItem('slicc-os.six-import'),
  }));

test('without a SLICC 6 profile seven never asks, and its service worker passes the upgrade page and /assets/ to the network even when OPFS has files there', async (t) => {
  mode = 'ok';
  const page = await open(t);
  const bios = await watch(page);
  const six = await dialog(page);
  asked.length = 0;
  await page.goto(`${origin}/7/`);
  await ready(page);
  assert.deepEqual(bios.states(), booted);
  assert.deepEqual(six.states(), []);
  assert.equal(asked.includes('/upgrade-to-seven.html'), false);
  assert.deepEqual(await storage(page), { marker: null, pending: null });

  const served = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const put = async (dir, name, text) => {
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    };
    await put(root, 'upgrade-to-seven.html', 'shadow page');
    const assets = await root.getDirectoryHandle('assets', { create: true });
    await put(assets, 'upgrade-to-seven-f1x7.js', 'shadow script');
    const read = async (path) => {
      const response = await fetch(path, { cache: 'no-store' });
      return { text: await response.text(), from: response.headers.get('x-served-from') };
    };
    return {
      page: await read('/upgrade-to-seven.html'),
      script: await read('/assets/upgrade-to-seven-f1x7.js'),
      controlled: navigator.serviceWorker.controller?.scriptURL,
    };
  });
  assert.equal(served.controlled, `${origin}/7/sw.js`);
  assert.match(served.page.text, /name="slicc-six-upgrade"/);
  assert.equal(served.page.from, null);
  assert.match(served.script.text, /slicc-six-kernel/);
  assert.equal(served.script.from, null);

  const tab = await page.tab();
  await runSix(tab);
  assert.equal(await tab.evaluate(() => location.pathname), '/');
  assert.deepEqual(page.errors, []);
});

test('moving SLICC 6 into seven from a cross-origin isolated BIOS: asked once, progress shown, the marker set before the frame goes, six stopped, /preview/ unregistered, / and the extension URLs land on /os/, and the export is handed to the agent', async (t) => {
  mode = 'ok';
  isolate = true;
  t.after(() => {
    isolate = false;
  });
  const page = await open(t);
  const six = await dialog(page);
  await runSix(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const exports = await root.getDirectoryHandle('slicc-v6-upgrade', { create: true });
    const old = await exports.getDirectoryHandle('interrupted-run', { create: true });
    await old.getFileHandle('cones.json', { create: true });
  });
  assert.deepEqual(await previews(page), ['/preview/']);
  const other = await page.tab();
  await runSix(other);

  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  const asking = await page.evaluate(() => ({
    title: document.querySelector('.six-title').textContent,
    body: document.querySelector('.six-body').textContent,
    buttons: [...document.querySelectorAll('.six .chip')].map((chip) => chip.textContent),
    focused: document.activeElement?.textContent,
    framed: document.querySelectorAll('iframe').length,
  }));
  assert.deepEqual(asking, {
    title: 'Move SLICC 6 into seven in this browser?',
    body: 'Your cones, files and skills from SLICC 6 move into seven. After that, SLICC 6 and its Chrome extension stop working in this browser.',
    buttons: ['Move to seven', 'Not now'],
    focused: 'Move to seven',
    framed: 0,
  });
  await page.evaluate(() => document.querySelector('.six-move').click());
  await page.until(() => location.pathname === '/os/');
  await other.until(() => document.getElementById('six').dataset.moved === 'yes');
  await page.send('Page.bringToFront');
  await ready(page);

  assert.deepEqual(six.states(), ['asking', 'moving', 'closed']);
  assert.deepEqual(six.framed(), [{ type: 'framed', src: `${origin}/upgrade-to-seven.html` }]);
  const lines = six.progress();
  assert.ok(lines.includes('Waiting for SLICC 6 tabs to stop'), lines.join('\n'));
  assert.ok(lines.includes('SLICC 6 stopped in this browser'), lines.join('\n'));
  assert.ok(lines.includes('Reading 0 of 1'), lines.join('\n'));
  assert.ok(lines.includes('Writing 1 of 1'), lines.join('\n'));
  const [removed] = six.removed();
  assert.equal(removed.marker, 'upgraded');
  assert.match(removed.pending, /^\/slicc-v6-upgrade\/[0-9a-f-]{36}\/$/);
  assert.equal(six.removed().length, 1);

  const kept = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const exports = await root.getDirectoryHandle('slicc-v6-upgrade');
    const names = [];
    for await (const name of exports.keys()) names.push(name);
    const pending = localStorage.getItem('slicc-os.six-import');
    const id = pending.split('/')[2];
    const manifest = JSON.parse(
      await (
        await (
          await (await exports.getDirectoryHandle(id)).getFileHandle('manifest.json')
        ).getFile()
      ).text()
    );
    return { names, id, files: manifest.files.map(({ path, source }) => `${path} ${source}`) };
  });
  assert.deepEqual(kept.names, [kept.id]);
  assert.deepEqual(kept.files, ['files/workspace/notes.txt /slicc-fs/workspace/notes.txt']);
  assert.deepEqual(await storage(page), {
    marker: 'upgraded',
    pending: `/slicc-v6-upgrade/${kept.id}/`,
  });

  assert.equal(await other.evaluate(() => document.getElementById('six').dataset.moved), 'yes');
  assert.deepEqual(await previews(page), []);

  for (const path of ['/', '/?slicc=leader&ext=x', '/?cherry=1&ui-only=1']) {
    const tab = await page.tab();
    await tab.goto(`${origin}${path}`);
    await tab.until(() => location.pathname === '/os/' && !!document.querySelector('slicc-app'));
    assert.equal(await tab.evaluate(() => document.getElementById('six')), null, path);
  }
  assert.deepEqual(page.errors, []);
});

test("when SLICC 6's exporter fails, seven sets no marker, six keeps working, and Not now boots seven", async (t) => {
  mode = 'error';
  const page = await open(t);
  const six = await dialog(page);
  await runSix(page);
  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  await page.evaluate(() => document.querySelector('.six-move').click());
  await showing(page, 'failed');
  const failed = await page.evaluate(() => ({
    title: document.querySelector('.six-title').textContent,
    body: document.querySelector('.six-body').textContent,
    buttons: [...document.querySelectorAll('.six .chip')].map((chip) => chip.textContent),
    frames: document.querySelectorAll('iframe').length,
  }));
  assert.deepEqual(failed, {
    title: 'Couldn’t move SLICC 6',
    body: `${STOP_ERROR} SLICC 6 still works in this browser.`,
    buttons: ['Try again', 'Not now'],
    frames: 0,
  });
  assert.deepEqual(await storage(page), { marker: null, pending: null });
  await page.evaluate(() => document.querySelector('.six-later').click());
  await ready(page);
  assert.deepEqual(six.states(), ['asking', 'moving', 'failed', 'closed']);
  assert.deepEqual(await storage(page), { marker: null, pending: null });
  assert.deepEqual(await previews(page), ['/preview/']);

  const tab = await page.tab();
  await runSix(tab);
  assert.equal(await tab.evaluate(() => location.pathname), '/');
  assert.deepEqual(page.errors, []);
});

test('messages from another frame or another origin are ignored, and declining asks again on the next boot', async (t) => {
  mode = 'spoof';
  const page = await open(t);
  const six = await dialog(page);
  await runSix(page);
  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  await page.evaluate(() => document.querySelector('.six-later').click());
  await ready(page);
  assert.deepEqual(six.states(), ['asking', 'closed']);
  assert.deepEqual(await storage(page), { marker: null, pending: null });

  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  await page.evaluate(() => {
    window.postMessage(
      {
        type: 'slicc-six-upgrade',
        done: true,
        exportId: 'window',
        dir: '/slicc-v6-upgrade/window/',
      },
      location.origin
    );
    document.querySelector('.six-move').click();
  });
  await ready(page);
  const { marker, pending } = await storage(page);
  assert.equal(marker, 'upgraded');
  assert.match(pending, /^\/slicc-v6-upgrade\/[0-9a-f-]{36}\/$/);
  assert.deepEqual(six.states(), ['asking', 'closed', 'asking', 'moving', 'closed']);
  assert.deepEqual(page.errors, []);
});

async function shots(page, name) {
  const dark = (value) =>
    page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    });
  await dark('light');
  await page.screenshot(new URL(`six-${name}-light.png`, page.dir));
  await dark('dark');
  await page.screenshot(new URL(`six-${name}-dark.png`, page.dir));
  await dark('light');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.until(() => innerWidth === 420);
  await page.screenshot(new URL(`six-${name}-420.png`, page.dir));
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.until(() => innerWidth !== 420);
}

test('the question, the progress and the failure, in light and dark and on a phone', async (t) => {
  mode = 'slow';
  const page = await open(t);
  await runSix(page);
  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  await shots(page, 'asking');
  await page.evaluate(() => document.querySelector('.six-move').click());
  await page.until(() => document.querySelector('.six-progress')?.textContent === 'Writing 0 of 1');
  assert.equal(await page.evaluate(() => document.querySelector('.six-bar').value), 0);
  await shots(page, 'moving');
  assert.deepEqual(await storage(page), { marker: null, pending: null });

  mode = 'error';
  const failing = await page.tab();
  await page.close();
  await failing.goto(`${origin}/7/`);
  await showing(failing, 'asking');
  await failing.evaluate(() => document.querySelector('.six-move').click());
  await showing(failing, 'failed');
  await shots(failing, 'failed');
  assert.deepEqual(page.errors, []);
});
