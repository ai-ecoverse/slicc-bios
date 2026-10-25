import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const installerSource = await readFile(new URL('../../src/installer.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
let bump = 0;

const PROBE = `(() => {
  const probe = (self.__installerProbe ??= {
    micro: false,
    timer: false,
    channel: false,
    streams: null,
    lifecycle: null,
  });
  if (!probe.armed) {
    probe.armed = true;
    queueMicrotask(() => {
      probe.micro = true;
    });
    setTimeout(() => {
      probe.timer = true;
    }, 0);
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      probe.channel = true;
    };
    channel.port2.postMessage(0);
    const controller = navigator.serviceWorker?.controller ?? null;
    probe.lifecycle = controller ? { state: controller.state, scriptURL: controller.scriptURL } : null;
    if (controller) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && 'streams' in event.data) probe.streams = event.data;
      });
      controller.postMessage({ streams: 'mine' });
    }
  }
  return {
    micro: probe.micro,
    timer: probe.timer,
    channel: probe.channel,
    streams: probe.streams,
    lifecycle: probe.lifecycle,
  };
})()`;

function scheduled(source) {
  const start = source.indexOf('function within(promise)');
  const end = source.indexOf('async function receive');
  if (start < 0 || end < 0) throw new Error('installer within() not found');
  const body = `function within(promise) {
  let channel;
  promise.catch(() => {});
  const since = Date.now();
  const idle = new Promise((resolve) => {
    const wait = () => {
      const quiet = Date.now() - Math.max(heard, since);
      if (quiet >= IDLE) resolve(stalled);
      else arm(IDLE - quiet);
    };
    const arm = (ms) => {
      const begin = performance.now();
      const next = new MessageChannel();
      channel = next;
      next.port1.onmessage = () => {
        if (performance.now() - begin >= ms) wait();
        else next.port2.postMessage(0);
      };
      next.port2.postMessage(0);
    };
    arm(IDLE);
  });
  return Promise.race([promise, idle]).finally(() => {
    channel?.port1.close();
  });
}

`;
  return `${source.slice(0, start)}${body}${source.slice(end)}`;
}

function watch() {
  const targets = new Map();
  const flights = [];
  const off = chrome.cdp.on(({ method, params, sessionId }) => {
    if (method === 'Target.attachedToTarget') {
      const info = params?.targetInfo;
      if (!info || (info.type !== 'shared_worker' && info.type !== 'service_worker')) return;
      const row = {
        type: info.type,
        url: info.url,
        waiting: params.waitingForDebugger === true,
        sessionId: params.sessionId,
        network: null,
      };
      targets.set(info.targetId, row);
      if (info.type === 'shared_worker' && info.url.includes('/installer.js')) {
        chrome.cdp
          .send('Network.enable', {}, params.sessionId)
          .then(() => {
            row.network = 'on';
          })
          .catch((error) => {
            row.network = error.message;
          });
      }
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      flights.push({
        sessionId,
        requestId: params.requestId,
        url: params.request?.url ?? '',
        type: params.type ?? '',
        done: false,
      });
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const row = flights.find(
        (flight) => flight.sessionId === sessionId && flight.requestId === params.requestId
      );
      if (row) row.done = true;
    }
  });
  const installer = () =>
    [...targets.values()]
      .filter((target) => target.type === 'shared_worker' && target.url.includes('/installer.js'))
      .at(-1);
  return {
    stop: off,
    installer,
    seen: () =>
      [...targets.values()].map(({ type, url, waiting, network }) => ({
        type,
        url,
        waiting,
        network,
      })),
    inflight(sessionId) {
      return flights
        .filter((flight) => flight.sessionId === sessionId && !flight.done)
        .map(({ url, type }) => ({ url: url.slice(0, 180), type }));
    },
  };
}

async function evaluate(sessionId, expression) {
  const result = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (result.exceptionDetails) {
    return {
      error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    };
  }
  return result.result?.value ?? null;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sample(tracker) {
  const target = tracker.installer();
  if (!target) return { missing: true, seen: tracker.seen() };
  const before = await evaluate(target.sessionId, PROBE).catch((error) => ({
    error: error.message,
  }));
  await pause(3000);
  const after = await evaluate(target.sessionId, PROBE).catch((error) => ({
    error: error.message,
  }));
  return {
    waiting: target.waiting,
    network: target.network,
    before,
    after,
    inflight: tracker.inflight(target.sessionId),
  };
}

async function hello(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const worker = new SharedWorker('/installer.js', 'slicc-installer');
        const timer = setTimeout(() => resolve({ hello: 'timeout' }), 3000);
        worker.port.onmessage = (event) => {
          clearTimeout(timer);
          const data = event.data;
          resolve({
            hello:
              data && 'result' in data
                ? data.result
                : data && 'error' in data
                  ? data.error
                  : 'message',
          });
        };
        worker.port.start();
        worker.port.postMessage({ id: 4242, op: 'hello' });
      })
  );
}

async function workers(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      active: registration?.active?.state ?? null,
      waiting: registration?.waiting?.state ?? null,
      installing: registration?.installing?.state ?? null,
    };
  });
}

function bumpWorker() {
  bump += 1;
  chrome.overrides.set(
    '/sw.js',
    workerSource.replace('const own = ', `const own =${' '.repeat(bump)} `)
  );
}

const settled = (page) =>
  page.within(5 * 60 * 1000, () => document.querySelector('slicc-app').model.updates.ready());

async function requestUpdate(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
    return (registration.installing ?? registration.waiting)?.state ?? null;
  });
}

async function settles(page, ms) {
  const started = Date.now();
  let error = null;
  try {
    await page.within(ms, async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return !registration?.waiting && !registration?.installing;
    });
  } catch (failure) {
    error = failure.message;
  }
  return { waited: Date.now() - started, error, ...(await workers(page)) };
}

function report(label, detail) {
  console.log(`installer-probe ${label} ${JSON.stringify(detail)}`);
}

test('the installer timer, its port, and its open fetches while an ordinary update is waiting', async (t) => {
  const tracker = watch();
  t.after(tracker.stop);
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  const reading = await sample(tracker);
  const greeted = await hello(page).catch((error) => ({ hello: error.message }));
  report('stock', { ...reading, ...greeted, workers: await workers(page) });
  assert.equal(reading.missing, undefined, JSON.stringify(tracker.seen()));
  bumpWorker();
  const updated = await requestUpdate(page);
  const held = await settles(page, 35000);
  const during = await sample(tracker);
  report('update', { updated, held, during });
  if (held.waiting || held.installing) {
    const target = tracker.installer();
    const closed = target
      ? await evaluate(target.sessionId, 'self.close()').catch((error) => error.message)
      : 'no installer session';
    const released = await settles(page, 20000);
    report('closed', { closed, released });
  }
});

test('an ordinary update after the installer waits on a message channel instead of a timer', async (t) => {
  chrome.overrides.set('/installer.js', scheduled(installerSource));
  t.after(() => chrome.overrides.delete('/installer.js'));
  const tracker = watch();
  t.after(tracker.stop);
  const page = await chrome.page(t);
  await boot(page);
  await settled(page);
  const reading = await sample(tracker);
  report('scheduled', { ...reading, workers: await workers(page) });
  assert.equal(reading.missing, undefined, JSON.stringify(tracker.seen()));
  bumpWorker();
  const updated = await requestUpdate(page);
  const held = await settles(page, 35000);
  report('scheduled-update', { updated, held, during: await sample(tracker) });
});
