import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const variant = env.R1 ?? '';
const minutes = Number(env.R1_MINUTES ?? (variant === 'fast' ? 3 : variant === 'frozen' ? 1 : 6));
const busy = env.R1_BUSY === '1';
const fast = ['--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10'];
const chrome = variant
  ? await launch({ realistic: true, stallAfter: 600000, args: variant === 'fast' ? fast : [] })
  : null;
after(() => chrome?.close());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WORKER = `
const gaps = [];
const fetches = [];
let last = Date.now();
let fired = null;
let due = null;
setInterval(() => {
  const now = Date.now();
  gaps.push([now, now - last]);
  last = now;
}, 1000);
self.onmessage = ({ data, ports }) => {
  if (data.echo) {
    ports[0].onmessage = (event) => ports[0].postMessage(event.data);
    return;
  }
  if (data.due) {
    due = data.due;
    setTimeout(() => {
      fired = Date.now();
    }, data.due - Date.now());
  }
  if (data.busy) {
    setInterval(async () => {
      const start = Date.now();
      try {
        await (await fetch(data.busy, { cache: 'no-store' })).text();
        fetches.push([start, Date.now() - start]);
      } catch {
        fetches.push([start, -1]);
      }
    }, 2000);
  }
  if (data.report) self.postMessage({ gaps, fetches, due, fired });
};
`;

async function owner(page, due) {
  return page.evaluate(
    async (source, due, busy) => {
      const tabs = await import('/os/tabs.js');
      const { createKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      const claimed = await tabs.claim(navigator.locks, 'r1-owner');
      const board = await tabs.joinSwitchboard({ versions: { bios: 'r1' } });
      const kernel = await createKernel({
        root: await navigator.storage.getDirectory(),
        media: false,
      });
      const worker = new Worker(
        URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      );
      worker.postMessage({ due, busy: busy && new URL('/os/index.html', location.href).href });
      const gaps = [];
      let last = Date.now();
      setInterval(() => {
        const now = Date.now();
        gaps.push([now, now - last]);
        last = now;
      }, 1000);
      const os = tabs.createOs({ ping: () => Date.now() });
      board.own(async () => {
        const echo = new MessageChannel();
        worker.postMessage({ echo: true }, [echo.port1]);
        return { kernel: await kernel.connect(), agent: echo.port2, os: os.open() };
      });
      await kernel.run(['sh', '-c', 'rm -f /tmp/r1.log']);
      void kernel.openTerminal(['sh', '-c', 'while :; do date +%s >> /tmp/r1.log; sleep 1; done'], {
        cols: 80,
        rows: 24,
      });
      const report = () =>
        new Promise((resolve) => {
          worker.addEventListener('message', ({ data }) => resolve(data), { once: true });
          worker.postMessage({ report: true });
        });
      window.r1 = { claimed, board, kernel, gaps, report };
      return claimed.owner;
    },
    WORKER,
    due,
    busy
  );
}

async function follower(page) {
  return page.evaluate(async () => {
    const tabs = await import('/os/tabs.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const board = await tabs.joinSwitchboard({ versions: { bios: 'r1' } });
    const ports = await board.ports();
    const client = await attachKernel(ports.kernel);
    const os = tabs.osClient(ports.os);
    const echo = ports.agent;
    echo.start();
    const samples = { ps: [], echo: [], os: [], stalls: [] };
    board.on('stalled', ({ since }) => samples.stalls.push(['stalled', Date.now(), since]));
    board.on('unstalled', () => samples.stalls.push(['unstalled', Date.now()]));
    const timed = async (list, call) => {
      const start = Date.now();
      try {
        await call();
        list.push([start, Date.now() - start]);
      } catch {
        list.push([start, -1]);
      }
    };
    const ping = () =>
      new Promise((resolve) => {
        echo.addEventListener('message', resolve, { once: true });
        echo.postMessage('ping');
      });
    let running = 0;
    setInterval(() => {
      if (running) return;
      running = 3;
      const done = () => {
        running -= 1;
      };
      void timed(samples.ps, () => client.ps()).then(done);
      void timed(samples.echo, ping).then(done);
      void timed(samples.os, () => os.call('ping')).then(done);
    }, 2000);
    window.r1 = { board, client, samples, visible: () => document.visibilityState };
    return document.visibilityState;
  });
}

function stats(values) {
  const sorted = values.filter((value) => value >= 0).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
  return {
    n: values.length,
    failed: values.filter((value) => value < 0).length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) ?? null,
  };
}

const within = (samples, [from, to]) =>
  samples.filter(([at]) => at >= from && at < to).map(([, value]) => value);

test(`R1: the owner tab in the background (${variant || 'off'})`, {
  skip: !variant && 'set R1',
}, async (t) => {
  const a = await chrome.page(t);
  await boot(a);
  const b = await a.tab();
  await boot(b);
  const start = Date.now();
  const due = start + (minutes * 60 + 90) * 1000;
  assert.equal(await owner(a, due), true);
  await follower(b);
  await b.send('Page.bringToFront');
  await sleep(60000);
  const visible = [start, Date.now()];
  let hiddenFrom = Date.now();
  let note = '';
  if (variant === 'frozen') {
    await a.send('Page.setWebLifecycleState', { state: 'frozen' });
    hiddenFrom = Date.now();
  } else if (variant === 'minimized') {
    try {
      const { windowId } = await a.send('Browser.getWindowForTarget');
      await a.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch (error) {
      note = `minimize failed: ${error.message}`;
    }
  } else {
    await b.send('Page.bringToFront');
  }
  await sleep(3000);
  const state = await a.evaluate(() => document.visibilityState);
  const followerState = await b.evaluate(() => document.visibilityState);
  await sleep(minutes * 60 * 1000 - 3000);
  const ownerStateLate = await a.evaluate(() => document.visibilityState);
  const followerStateLate = await b.evaluate(() => document.visibilityState);
  const background = [hiddenFrom, Date.now()];
  if (variant === 'frozen') await a.send('Page.setWebLifecycleState', { state: 'active' });
  if (variant === 'minimized' && !note) {
    const { windowId } = await a.send('Browser.getWindowForTarget');
    await a.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  }
  await a.send('Page.bringToFront');
  await sleep(Math.max(0, due - Date.now()) + 5000);
  const owned = await a.evaluate(async () => ({
    gaps: window.r1.gaps,
    worker: await window.r1.report(),
  }));
  const followed = await b.evaluate(async () => {
    const read = await window.r1.client.run(['cat', '/tmp/r1.log']);
    const ticks = read.stdout.trim().split('\n').map(Number);
    return { samples: window.r1.samples, ticks };
  });
  const tickGaps = followed.ticks
    .slice(1)
    .map((s, i) => [s * 1000, (s - followed.ticks[i]) * 1000]);
  const phases = { visible, background };
  const result = {
    variant,
    minutes,
    busy,
    note,
    ownerState: state,
    followerState,
    ownerStateLate,
    followerStateLate,
    cronLateMs: owned.worker.fired ? owned.worker.fired - owned.worker.due : null,
    stalls: followed.samples.stalls,
  };
  for (const [phase, range] of Object.entries(phases)) {
    result[phase] = {
      mainGap: stats(within(owned.gaps, range)),
      workerGap: stats(within(owned.worker.gaps, range)),
      workerFetch: stats(within(owned.worker.fetches, range)),
      kernelTick: stats(within(tickGaps, range)),
      ps: stats(within(followed.samples.ps, range)),
      echo: stats(within(followed.samples.echo, range)),
      os: stats(within(followed.samples.os, range)),
    };
  }
  console.log(`R1 ${JSON.stringify(result)}`);
  await mkdir(new URL('../../artifacts/', import.meta.url), { recursive: true });
  await writeFile(
    new URL(`../../artifacts/r1-${variant}${busy ? '-busy' : ''}.json`, import.meta.url),
    JSON.stringify(result, null, 2)
  );
});
