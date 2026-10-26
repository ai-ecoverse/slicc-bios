import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { download } from '../../node_modules/@ai-ecoverse/slicc-shared-web/harness/cdn.mjs';
import { boot } from './bios.mjs';
import { launch, RELEASES_KEY } from './chrome.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
const { dependencies } = JSON.parse(
  await readFile(new URL('../../src/packages/package.json', import.meta.url), 'utf8')
);
const NPM = `https://registry.npmjs.org/@ai-ecoverse%2Fslicc-kernel/${dependencies['@ai-ecoverse/slicc-kernel']}`;
const HOLD = 5000;
const SIZE = 64 * 1024 * 1024;
let bump = 0;

async function updateWhileHolding(page, url, traffic = null) {
  bump += 1;
  chrome.overrides.set(
    '/sw.js',
    current.replace('const own = ', `const own =${' '.repeat(bump)} `)
  );
  return page.evaluate(
    async ([url, hold, traffic]) => {
      const start = performance.now();
      const at = () => Math.round(performance.now() - start);
      const log = [];
      const response = await fetch(url);
      const reader = response.body.getReader();
      log.push(
        `${at()} ${url} ${response.status}, read ${(await reader.read()).value?.byteLength}`
      );
      const registration = await navigator.serviceWorker.getRegistration();
      await registration.update();
      const worker = registration.installing ?? registration.waiting;
      if (!worker) return { log: [...log, 'no new worker'], held: null, released: null };
      worker.addEventListener('statechange', () => log.push(`${at()} ${worker.state}`));
      const until = async (ms) => {
        const end = performance.now() + ms;
        while (worker.state !== 'activated' && performance.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 50));
      };
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(100000);
      let busy = Boolean(traffic);
      let fetched = 0;
      const loop = async () => {
        while (busy) {
          await fetch(traffic, { cache: 'no-store' })
            .then((response) => response.arrayBuffer())
            .catch(() => undefined);
          fetched += 1;
        }
      };
      const loops = [];
      if (traffic) {
        await until(hold - 1000);
        for (let i = 0; i < 4; i += 1) loops.push(loop());
        await until(1000);
      } else await until(hold);
      const held = worker.state;
      await reader.cancel();
      log.push(`${at()} cancelled`);
      await until(hold);
      busy = false;
      await Promise.all(loops);
      if (traffic) log.push(`${at()} fetched ${traffic} ${fetched} times`);
      const own = new URL('/os/notices.js', location.href).href;
      await (await fetch(own, { cache: 'no-store' })).text();
      const sources = (name) => [
        ...new Set(
          performance
            .getEntriesByName(new URL(name, location.href).href)
            .map((entry) => entry.workerMatchedSourceType)
        ),
      ];
      return {
        log,
        held,
        released: worker.state,
        fetched,
        sources: { own: sources(own), traffic: traffic ? sources(traffic) : [] },
      };
    },
    [url, HOLD, traffic]
  );
}

const RELEASES = 'https://releases.invalid';

async function opened(t) {
  const page = await chrome.page(t);
  await page.init(
    `() => { if (location.origin === ${JSON.stringify(new URL(chrome.url).origin)}) localStorage.setItem(${JSON.stringify(RELEASES_KEY)}, ${JSON.stringify(RELEASES)}); }`
  );
  return page;
}

test('Chrome keeps an updated worker installed while a page holds a half-read streamed response from the old one, activates it once the page cancels, and a blob body holds nothing (#699)', async (t) => {
  const page = await opened(t);
  await boot(page);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  const streamed = await updateWhileHolding(page, '/os/held.bin');
  assert.deepEqual(
    [streamed.held, streamed.released],
    ['installed', 'activated'],
    streamed.log.join('\n')
  );
  await page.evaluate(async (size) => {
    const home = await (await navigator.storage.getDirectory()).getDirectoryHandle('home', {
      create: true,
    });
    const writable = await (
      await home.getFileHandle('held.bin', { create: true })
    ).createWritable();
    await writable.write(new Uint8Array(size));
    await writable.close();
  }, SIZE);
  const blob = await updateWhileHolding(page, '/home/held.bin');
  assert.equal(blob.held, 'activated', blob.log.join('\n'));
  assert.deepEqual(page.errors, []);
});

test('an update activates within 5 s of the cancel while the page keeps fetching from npm, since that goes straight to the network and never wakes the old worker (#728)', async (t) => {
  const page = await opened(t);
  await boot(page);
  chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
  await download(NPM);
  const streamed = await updateWhileHolding(page, '/os/held.bin', NPM);
  const log = streamed.log.join('\n');
  assert.deepEqual([streamed.held, streamed.released], ['installed', 'activated'], log);
  assert.ok(streamed.fetched >= 20, log);
  assert.deepEqual(streamed.sources, { own: ['fetch-event'], traffic: ['network'] }, log);
  const kernel = await page.evaluate(() =>
    Promise.all(
      ['http://1.kernel.localhost/', 'https://1.kernel.localhost/'].map((url) =>
        fetch(url).then(
          async (response) => `${response.status} ${(await response.text()).slice(0, 3)}`,
          (error) => `${error.name}`
        )
      )
    )
  );
  assert.deepEqual(kernel, ['502 sw:', '502 sw:']);
  assert.deepEqual(page.errors, []);
});
