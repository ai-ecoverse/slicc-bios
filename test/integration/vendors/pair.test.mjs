import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { firefox, webkit } from 'playwright-core';
import { cliEnv } from '../cli.mjs';

const cli = process.env.SLICC_CLI;
const PAGE = 'https://seven.pair.test/';
const PORTS = '17190-17199';
const STEP = 60_000;
const seed = new URL('../../../src/seed/', import.meta.url);

const HTML = `<!doctype html><meta charset="utf-8"><title>pair</title><script type="module">
import { createExitRouter } from '/os/exits.js';
import { createLinks } from '/os/link.js';
import { createPairing } from '/os/pair.js';
const links = createLinks({ router: createExitRouter(), makePeer: (config) => new RTCPeerConnection(config) });
globalThis.paired = { links, pairing: createPairing({ links }) };
</script>`;

const opened = [];
after(async () => {
  for (const browser of opened) await browser.close().catch(() => {});
});

async function page(t, engine) {
  const browser = await engine.launch({ headless: true });
  opened.push(browser);
  const context = await browser.newContext();
  t.after(() => context.close().catch(() => {}));
  await context.route(`${PAGE}**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: HTML });
    if (!/^\/os\/[a-z-]+\.js$/.test(pathname)) return route.fulfill({ status: 404, body: '' });
    const body = await readFile(new URL(pathname.slice('/os/'.length), seed), 'utf8');
    return route.fulfill({ contentType: 'text/javascript', body });
  });
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.goto(PAGE);
  await tab.waitForFunction(() => globalThis.paired, null, { timeout: STEP });
  return { tab, errors };
}

async function slicc(t) {
  const home = await mkdtemp(join(tmpdir(), 'pair-vendor-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const node = spawn(
    cli,
    ['pair', '--page', PAGE, '--name', 'quay-studio', '--no-kernel', '--no-jerk'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: cliEnv({
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        SLICC_LOOPBACK_PORTS: PORTS,
        SLICC_NO_TELEMETRY: '1',
        SLICC_NO_UPDATE_CHECK: '1',
      }),
    }
  );
  const exited = new Promise((resolve) => node.once('exit', resolve));
  const signal = (name) => {
    try {
      process.kill(-node.pid, name);
    } catch {}
  };
  t.after(async () => {
    signal('SIGTERM');
    let timer;
    const gone = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 5000, false);
      }),
    ]);
    clearTimeout(timer);
    if (!gone) signal('SIGKILL');
    await exited;
    node.stdout.destroy();
    node.stderr.destroy();
  });
  const said = [];
  const heard = new Set();
  createInterface({ input: node.stderr }).on('line', (line) => {
    said.push(line);
    for (const wait of heard) wait(line);
  });
  const hear = (text) =>
    new Promise((resolve) => {
      if (said.some((line) => line.includes(text))) return resolve(true);
      const timer = setTimeout(() => {
        heard.delete(wait);
        resolve(false);
      }, STEP);
      const wait = (line) => {
        if (!line.includes(text)) return;
        clearTimeout(timer);
        heard.delete(wait);
        resolve(true);
      };
      heard.add(wait);
    });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no pairing URL: ${said.join('\n')}`)), STEP);
    createInterface({ input: node.stdout }).on('line', (line) => {
      if (!line.includes('#slicc-pair=')) return;
      clearTimeout(timer);
      resolve(line.trim());
    });
  });
  return { url, said, hear };
}

async function attempt(tab, url) {
  const fp = new URL(url).hash.split('.').at(-1);
  const started = Date.now();
  const result = await tab.evaluate(
    async ([url, fp]) => {
      const { pairing, links } = globalThis.paired;
      await pairing.begin(url);
      await pairing.confirm();
      const status = pairing.status();
      const end = Date.now() + 30_000;
      while (status.state === 'linked' && Date.now() < end) {
        const row = links.devices().find((device) => device.id === fp);
        if (row?.state === 'connected')
          return { status, row: { state: row.state, mode: row.mode } };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { status, row: links.devices().find((device) => device.id === fp) ?? null };
    },
    [url, fp]
  );
  return { ...result, took: Date.now() - started };
}

test('Firefox: an https seven pairs slicc pair over loopback and links', {
  skip: !cli,
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const { tab, errors } = await page(t, firefox);
  const { url, said, hear } = await slicc(t);
  const { status, row, took } = await attempt(tab, url);
  t.diagnostic(`Firefox: ${JSON.stringify({ status, row })} in ${took} ms`);
  assert.equal(status.state, 'linked', JSON.stringify(status));
  assert.equal(status.name, 'quay-studio');
  assert.deepEqual(row, { state: 'connected', mode: 'local' }, said.join('\n'));
  assert.ok(await hear('paired with seven on https://seven.pair.test ('), said.join('\n'));
  assert.deepEqual(errors, []);
});

test('WebKit: an https seven may not reach http://127.0.0.1, so the attempt fails at once and says so, and slicc sees no request', {
  skip: !cli,
  timeout: 5 * 60 * 1000,
}, async (t) => {
  const { tab, errors } = await page(t, webkit);
  const { url, said } = await slicc(t);
  const { status, row, took } = await attempt(tab, url);
  t.diagnostic(`WebKit: ${JSON.stringify({ status, row })} in ${took} ms`);
  assert.equal(status.state, 'failed', JSON.stringify(status));
  assert.equal(
    status.error,
    'Safari doesn’t let an https page reach slicc on this computer, so seven can’t pair here. Use the join command under Link another device, or open seven in Chrome, Edge or Firefox.'
  );
  assert.ok(took < 20_000, `the attempt took ${took} ms`);
  assert.equal(row, null);
  assert.deepEqual(
    said.filter((line) => /paired with|refused a pairing/.test(line)),
    []
  );
  assert.deepEqual(
    errors.filter((error) => !/127\.0\.0\.1:\d+\/slicc\/v1\/pair\b/.test(error)),
    [],
    'only WebKit’s report of the blocked request'
  );
});
