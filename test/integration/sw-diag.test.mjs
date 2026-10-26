import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { boot } from './bios.mjs';
import { launch } from './chrome.mjs';

const chrome = await launch({ tools: false });
after(() => chrome.close());

const current = await readFile(new URL('../../src/sw.js', import.meta.url), 'utf8');
const RACE = 'Promise.race([ended, reader.read(), idle.late])';
assert.ok(current.includes(RACE));
const variants = {
  main: current.replace(RACE, 'Promise.race([reader.read(), idle.late])'),
  fix: current,
};
const SIZE = 64 * 1024 * 1024;
const WATCH = 25000;
let bump = 0;

const TRICKLE = `() => {
  if (!location.pathname.startsWith('/os/')) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.loopback?.port !== 4999) return;
    event.stopImmediatePropagation();
    const [reply] = event.ports;
    let n = 0;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async pull(stream) {
        await new Promise((resolve) => setTimeout(resolve, n === 0 ? 0 : 1000));
        n += 1;
        stream.enqueue(encoder.encode('data: tick ' + n + '\\n\\n'));
      },
    });
    reply.postMessage(
      { status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream'], ['cache-control', 'no-cache']], body },
      [body]
    );
  });
}`;

const consumers = {
  download: () => {
    window.probe = { bytes: 0, end: null };
    void (async () => {
      try {
        const reader = (await fetch('/os/held.bin')).body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            window.probe.end = 'done';
            return;
          }
          window.probe.bytes += value.byteLength;
          await new Promise((resolve) => setTimeout(resolve, value.byteLength / 2048));
        }
      } catch (error) {
        window.probe.end = `${error.name}: ${error.message}`;
      }
    })();
  },
  half: () => {
    window.probe = { bytes: 0, end: null };
    void (async () => {
      const reader = (await fetch('/os/held.bin')).body.getReader();
      window.probe.bytes += (await reader.read()).value.byteLength;
      window.heldReader = reader;
    })();
  },
  sse: () => {
    window.probe = { events: 0, opens: 0, errors: 0, state: null };
    const source = new EventSource('http://4999.kernel.localhost/events');
    source.onopen = () => {
      window.probe.opens += 1;
      window.probe.state = source.readyState;
    };
    source.onmessage = () => {
      window.probe.events += 1;
    };
    source.onerror = () => {
      window.probe.errors += 1;
      window.probe.state = source.readyState;
    };
  },
  trickle: () => {
    window.probe = { events: 0, end: null };
    void (async () => {
      try {
        const reader = (await fetch('http://4999.kernel.localhost/events')).body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) {
            window.probe.end = 'done';
            return;
          }
          window.probe.events += 1;
        }
      } catch (error) {
        window.probe.end = `${error.name}: ${error.message}`;
      }
    })();
  },
};

for (const variant of Object.keys(variants))
  for (const [name, consumer] of Object.entries(consumers))
    test(`diag ${variant} ${name}`, async (t) => {
      const page = await chrome.page(t);
      chrome.overrides.set('/sw.js', variants[variant]);
      chrome.overrides.set('/os/held.bin', Buffer.alloc(SIZE, 7));
      await page.init(TRICKLE);
      await boot(page);
      const booted = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        const text = await (
          await fetch(registration.active.scriptURL, { cache: 'no-store' })
        ).text();
        return text.includes('Promise.race([ended, reader.read(), idle.late])') ? 'fix' : 'main';
      });
      assert.equal(booted, variant);
      await page.within(5 * 60 * 1000, () =>
        document.querySelector('slicc-app').model.updates.ready()
      );
      await page.evaluate(consumer);
      await page.within(
        10000,
        () => window.probe && (window.probe.bytes > 0 || window.probe.events > 0)
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      bump += 1;
      chrome.overrides.set(
        '/sw.js',
        variants[variant].replace('const own = ', `const own =${' '.repeat(bump)} `)
      );
      const log = await page.evaluate(async (ms) => {
        const t0 = performance.now();
        const at = () => Math.round(performance.now() - t0);
        const log = [];
        const registration = await navigator.serviceWorker.getRegistration();
        navigator.serviceWorker.addEventListener('controllerchange', () =>
          log.push(`${at()} controllerchange`)
        );
        await registration.update();
        const worker = registration.installing ?? registration.waiting;
        log.push(`${at()} update: ${worker?.state ?? 'none'}`);
        worker?.addEventListener('statechange', () => log.push(`${at()} ${worker.state}`));
        let last = '';
        let sampled = -2000;
        while (performance.now() - t0 < ms) {
          const { bytes, ...rest } = window.probe;
          const now = JSON.stringify(rest);
          if (now !== last || at() - sampled >= 2000) {
            log.push(`${at()} ${now}${bytes === undefined ? '' : ` bytes=${bytes}`}`);
            last = now;
            sampled = at();
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const end = await navigator.serviceWorker.getRegistration();
        log.push(
          `${at()} end: active=${end.active?.state} waiting=${end.waiting?.state ?? null} installing=${end.installing?.state ?? null}`
        );
        return log;
      }, WATCH);
      t.diagnostic(`${variant} ${name}\n${log.join('\n')}`);
      console.log(`DIAG ${variant} ${name}\n${log.join('\n')}`);
    });
