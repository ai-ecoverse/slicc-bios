import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findBrowser } from '@ai-ecoverse/slicc-cdp';
import { serve } from '@ai-ecoverse/slicc-shared-web/harness';
import { chromium } from 'playwright-core';
import { startHub } from './fake-hub.mjs';
import { leaseTestBuild } from './lease-test-build.mjs';

export async function localJob(t, { dist, wasm }) {
  const hub = await startHub();
  t.after(() => hub.close());
  const web = await serve({
    isolated: true,
    roots: [
      ['/candidate/', dist],
      ['/fixture/', 'test/integration/fixtures/'],
      ['/', 'src/'],
    ],
  });
  t.after(() => web.close());
  web.overrides.set('/seed/lease-build.js', leaseTestBuild);
  web.overrides.set('/candidate.wasm', await readFile(wasm));
  web.overrides.set('/blank.html', '<!doctype html><title>Job kernel fixture</title>');
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (await findBrowser())?.executable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${web.url}blank.html`);
  const leaderPin = await page.evaluate(async () => {
    globalThis.cert = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
    });
    return cert
      .getFingerprints()
      .find((f) => f.algorithm === 'sha-256')
      .value.replaceAll(':', '')
      .toLowerCase();
  });
  return {
    hub,
    page,
    browser,
    leaderPin,
    url: web.url,
    async start(broker) {
      return page.evaluate(
        async ({ hub, broker }) => {
          const module = await import('/candidate/index.js');
          const { bootLeaseJob } = await import('/seed/lease-job.js');
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(
            crypto.randomUUID(),
            { create: true }
          );
          async function install(path, bytes) {
            const parts = path.split('/');
            const name = parts.pop();
            let dir = root;
            for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
            const writer = await (await dir.getFileHandle(name, { create: true })).createWritable();
            await writer.write(bytes);
            await writer.close();
          }
          const pkg = 'node_modules/@ai-ecoverse/slicc-cdp';
          const file = 'bin/playwright-cli.wasm';
          await install(
            `${pkg}/package.json`,
            JSON.stringify({
              name: '@ai-ecoverse/slicc-cdp',
              slicc: { abi: 'wasi', commands: { 'playwright-cli': { wasm: file } } },
            })
          );
          await install(`${pkg}/${file}`, await (await fetch('/candidate.wasm')).arrayBuffer());
          const job = await bootLeaseJob(module, { root, origin: hub, broker, certificate: cert });
          globalThis.leaseState = job;
          globalThis.client = await module.attachKernel(job.port);
          globalThis.stopJob = async () => {
            await client.close();
            job.close();
          };
          if (!job.tray.pairing())
            await new Promise((resolve) => {
              const off = job.tray.on(() => {
                if (job.tray.pairing()) {
                  off();
                  resolve();
                }
              });
            });
          return job.tray.pairing().joinUrl;
        },
        { hub: hub.url, broker }
      );
    },
    wait(field, value) {
      return page.evaluate(
        ([field, value]) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              off();
              reject(
                new Error(
                  `Timed out waiting for lease ${field}; state: ${JSON.stringify(leaseState.status())}`
                )
              );
            }, 12000);
            const check = () => {
              const v = leaseState.status()[field];
              if (value === null ? v !== null : v === value) {
                off();
                clearTimeout(timer);
                resolve(v);
              }
            };
            const off = leaseState.on(check);
            check();
          }),
        [field, value ?? null]
      );
    },
    async run(...args) {
      return page.evaluate((args) => client.run(['playwright-cli', ...args], { cwd: '/' }), args);
    },
    async request(site = 'https://billing.example') {
      const r = await this.run('lease', 'request', '--allow', site, '--for', '1h');
      assert.equal(r.status, 0, r.stderr);
      const lease = /^Lease: ([\w-]+)$/m.exec(r.stdout)?.[1];
      const jkt = /--to jkt:([\w-]{43}) /.exec(r.stdout)?.[1];
      assert.ok(lease && jkt, 'missing opaque handle or review thumbprint');
      return { lease, jkt };
    },
  };
}
