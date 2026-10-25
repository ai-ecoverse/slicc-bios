import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { booted, ready, watch } from './bios.mjs';
import { launch, VAULT_KEY } from './chrome.mjs';
import { STOP_ERROR, startWww } from './fake-six.mjs';

const chrome = await launch();
const www = await startWww(new URL(chrome.url));
const { origin, state } = www;
const asked = state.asked;
after(async () => {
  await www.close();
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
      document.querySelector('.six').matches(':modal') &&
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
  state.mode = 'ok';
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

test("when www never answers for SLICC 6's upgrade page, the BIOS stops waiting and boots seven without asking", async (t) => {
  state.mode = 'stall';
  const page = await open(t);
  const bios = await watch(page);
  const six = await dialog(page);
  await runSix(page);
  asked.length = 0;
  await page.goto(`${origin}/7/`);
  await page.within(60000, () => location.pathname === '/os/');
  const waited = Date.now() - state.stalled;
  assert.ok(waited < 20000, `the BIOS waited ${waited} ms for the upgrade page`);
  await ready(page);
  assert.deepEqual(bios.states(), booted);
  assert.ok(asked.includes('/upgrade-to-seven.html'), asked.join(' '));
  assert.deepEqual(six.states(), []);
  assert.deepEqual(six.framed(), []);
  assert.deepEqual(await storage(page), { marker: null, pending: null });
  assert.deepEqual(await previews(page), ['/preview/']);
  assert.deepEqual(page.errors, []);
});

test("a second tab whose check for SLICC 6's upgrade page answers after the first tab's move doesn't ask again", async (t) => {
  state.mode = 'ok';
  const page = await open(t);
  await runSix(page);
  const other = await page.tab();
  const six = await dialog(other);
  await page.send('Page.bringToFront');
  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  let release;
  state.hold = new Promise((done) => {
    release = done;
  });
  const late = other.goto(`${origin}/7/`);
  for (const until = Date.now() + 60000; state.hold !== null; ) {
    assert.ok(Date.now() < until, 'the second tab never asked for the upgrade page');
    await new Promise((done) => setTimeout(done, 50));
  }
  await page.evaluate(() => document.querySelector('.six-move').click());
  await ready(page);
  const moved = await storage(page);
  assert.equal(moved.marker, 'upgraded');
  await other.send('Page.bringToFront');
  release();
  await late;
  await ready(other);
  assert.deepEqual(six.states(), []);
  assert.deepEqual(six.framed(), []);
  assert.deepEqual(await storage(other), moved);
  const switched =
    /^InvalidStateError: Transition was aborted because of invalid state\. Viewport size changed$/;
  assert.deepEqual(
    page.errors.filter((error) => !switched.test(error)),
    []
  );
  assert.deepEqual(
    other.errors.filter((error) => !switched.test(error)),
    []
  );
});

test("a kernel process can't retire SLICC 6: what a worker on seven's origin writes doesn't make / redirect to /os/", async (t) => {
  state.mode = 'ok';
  const page = await open(t);
  await page.goto(`${origin}/7/`);
  await ready(page);
  const forged = await page.evaluate(async () => {
    const source = `
      const results = {};
      results.cookieStore = typeof self.cookieStore;
      results.cookie = typeof self.document;
      await caches.open('slicc-bios.six-retired');
      await caches.open('__Host-slicc-six-retired');
      results.caches = await caches.keys();
      postMessage(results);
    `;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    try {
      return await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('the worker posted nothing in 20 s')), 20000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          done(data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          fail(new Error(`the worker failed: ${event.message}`));
        };
      });
    } finally {
      worker.terminate();
    }
  });
  assert.deepEqual(forged.cookieStore, 'undefined');
  assert.deepEqual(forged.cookie, 'undefined');
  assert.ok(forged.caches.includes('slicc-bios.six-retired'), JSON.stringify(forged));
  const tab = await page.tab();
  await runSix(tab);
  assert.equal(await tab.evaluate(() => location.pathname), '/');
  assert.deepEqual(page.errors, []);
  assert.deepEqual(tab.errors, []);
});

test('moving SLICC 6 into seven from a cross-origin isolated BIOS: asked once, progress shown, the marker set before the frame goes, six stopped, /preview/ unregistered, / and the extension URLs land on /os/, and the export is handed to the agent', async (t) => {
  state.mode = 'ok';
  state.isolate = true;
  t.after(() => {
    state.isolate = false;
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
    outside: (() => {
      document.querySelector('.details').focus();
      return document.activeElement?.textContent;
    })(),
  }));
  await page.press('d');
  assert.equal(
    await page.evaluate(() => document.querySelector('.diagnostics').classList.contains('open')),
    false
  );
  assert.deepEqual(asking, {
    title: 'Move SLICC 6 into seven in this browser?',
    body: 'Your cones, files and skills from SLICC 6 move into seven. Files move as they are, including any keys or passwords written inside them. After that, SLICC 6 and its Chrome extension stop working in this browser.',
    buttons: ['Move to seven', 'Not now'],
    focused: 'Not now',
    framed: 0,
    outside: 'Not now',
  });
  await page.evaluate(() => document.querySelector('.six-move').click());
  await page.until(() => location.pathname === '/os/');
  await other.until(() => document.getElementById('six').dataset.moved === 'yes');
  await page.send('Page.bringToFront');
  await ready(page);

  assert.deepEqual(six.states(), ['asking', 'moving', 'closed']);
  assert.deepEqual(six.framed(), [{ type: 'framed', src: `${origin}/upgrade-to-seven.html` }]);
  const lines = six.progress();
  assert.ok(lines.includes('Stopping SLICC 6 tabs…'), lines.join('\n'));
  assert.ok(lines.includes('Reading files: 0 of 1'), lines.join('\n'));
  assert.ok(lines.includes('Reading files: 1 of 1'), lines.join('\n'));
  assert.ok(lines.includes('Writing the export: 1 of 1'), lines.join('\n'));
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
  assert.deepEqual(kept.files, ['files/home-user/notes.txt /slicc-fs/home/user/notes.txt']);
  assert.deepEqual(await storage(page), {
    marker: 'upgraded',
    pending: `/slicc-v6-upgrade/${kept.id}/`,
  });

  assert.equal(await other.evaluate(() => document.getElementById('six').dataset.moved), 'yes');
  assert.deepEqual(await previews(page), []);

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/preview-sw.js', {
      scope: '/preview/',
    });
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (worker.state !== 'activated') {
      await new Promise((done) =>
        worker.addEventListener('statechange', () => worker.state === 'activated' && done())
      );
    }
  });
  assert.deepEqual(await previews(page), ['/preview/']);
  for (const path of ['/', '/?slicc=leader&ext=x', '/?cherry=1&ui-only=1']) {
    const tab = await page.tab();
    await tab.goto(`${origin}${path}`);
    await tab.until(() => location.pathname === '/os/' && !!document.querySelector('slicc-app'));
    assert.equal(await tab.evaluate(() => document.getElementById('six')), null, path);
  }
  await page.within(30000, async () => {
    const left = await navigator.serviceWorker.getRegistrations();
    return left.every(
      (registration) => !new URL(registration.scope).pathname.startsWith('/preview/')
    );
  });
  assert.deepEqual(page.errors, []);
});

test("when SLICC 6's exporter fails, seven sets no marker, six keeps working, and Escape boots seven", async (t) => {
  state.mode = 'error';
  const page = await open(t);
  const six = await dialog(page);
  await runSix(page);
  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  await page.evaluate(() => document.querySelector('.six-move').click());
  await showing(page, 'failed');
  const failed = await page.evaluate(() => ({
    focused: document.activeElement?.textContent,
    title: document.querySelector('.six-title').textContent,
    body: document.querySelector('.six-body').textContent,
    buttons: [...document.querySelectorAll('.six .chip')].map((chip) => chip.textContent),
    frames: document.querySelectorAll('iframe').length,
  }));
  assert.deepEqual(failed, {
    focused: 'Not now',
    title: 'Couldn’t move SLICC 6',
    body: `${STOP_ERROR} SLICC 6 still works in this browser.`,
    buttons: ['Try again', 'Not now'],
    frames: 0,
  });
  assert.deepEqual(await storage(page), { marker: null, pending: null });
  await page.press('Escape');
  await ready(page);
  assert.deepEqual(six.states(), ['asking', 'moving', 'failed', 'closed']);
  assert.deepEqual(await storage(page), { marker: null, pending: null });
  assert.deepEqual(await previews(page), ['/preview/']);

  const tab = await page.tab();
  await runSix(tab);
  assert.equal(await tab.evaluate(() => location.pathname), '/');
  assert.deepEqual(page.errors, []);
});

test('Enter at the question declines, the next boot asks again, and messages from another frame or another origin are ignored', async (t) => {
  state.mode = 'spoof';
  const page = await open(t);
  const six = await dialog(page);
  await runSix(page);
  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Not now');
  await page.enter();
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
  state.mode = 'slow';
  const page = await open(t);
  await runSix(page);
  await page.goto(`${origin}/7/`);
  await showing(page, 'asking');
  await shots(page, 'asking');
  await page.evaluate(() => document.querySelector('.six-move').click());
  await page.until(
    () => document.querySelector('.six-progress')?.textContent === 'Writing the export: 0 of 1'
  );
  assert.equal(await page.evaluate(() => document.querySelector('.six-bar').value), 0);
  await page.press('Escape');
  assert.equal(
    await page.evaluate(() => {
      const box = document.querySelector('.six');
      return `${box.dataset.state} ${box.matches(':modal')}`;
    }),
    'moving true'
  );
  await shots(page, 'moving');
  assert.deepEqual(await storage(page), { marker: null, pending: null });

  state.mode = 'error';
  const failing = await page.tab();
  await page.close();
  await failing.goto(`${origin}/7/`);
  await showing(failing, 'asking');
  await failing.evaluate(() => document.querySelector('.six-move').click());
  await showing(failing, 'failed');
  await shots(failing, 'failed');
  assert.deepEqual(page.errors, []);
});
