import assert from 'node:assert/strict';
import { serve } from '@ai-ecoverse/slicc-shared-web/harness';
import { chromium } from 'playwright-core';
import { startHub } from '../fake-hub.mjs';
import { leaseTestBuild } from '../lease-test-build.mjs';

async function install({ origin, broker }) {
  const { createLeaseTray } = await import('/seed/tray.js');
  const { createLeaseJob } = await import('/seed/lease-job.js');
  const { measuredJob } = await import('/fixture/tap.mjs');
  const tag = crypto.randomUUID(),
    ctx = { stamp: { tag }, signal: new AbortController().signal };
  const job = await createLeaseJob(tag),
    counts = {},
    handles = new Map(),
    requests = new Map(),
    listeners = new Set();
  const change = () => {
    for (const fn of listeners) fn();
  };
  job.on(change);
  const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
  const tray = createLeaseTray({
    job: measuredJob(job, counts, change),
    broker,
    origin,
    certificate: cert,
  });
  tray.on(change);
  function until(ready) {
    return new Promise((resolve, reject) => {
      const clock = setTimeout(() => {
        listeners.delete(check);
        reject(new Error('Timed out waiting for a fixture state transition'));
      }, 10000);
      const check = () => {
        if (ready()) {
          clearTimeout(clock);
          listeners.delete(check);
          resolve();
        }
      };
      listeners.add(check);
      check();
    });
  }
  function safeError(e) {
    return [
      'E_SCOPE',
      'E_PENDING',
      'E_REVOKED',
      'E_UNSUPPORTED',
      'E_UNAVAILABLE',
      'E_EXPIRED',
      'E_DENIED',
    ].includes(e?.reason)
      ? e.reason
      : 'unexpected-error';
  }
  globalThis.probe = {
    counts,
    async request({ label, allow, from }) {
      try {
        const r = await job.adapter.request(
          { allow, ...(from ? { lease: handles.get(from) } : { ttlSeconds: 60 }) },
          ctx
        );
        if ([...handles.values()].includes(r.lease)) return 'duplicate-handle';
        handles.set(label, r.lease);
        requests.set(label, r);
        return 'ok';
      } catch (e) {
        return safeError(e);
      }
    },
    async action({ label, op, args, marker }) {
      try {
        const { result } = await job.adapter.action({ lease: handles.get(label), op, args }, ctx);
        if (op === 'snapshot')
          return result.text.includes(marker) && !result.text.includes('Support frame fixture only')
            ? 'ok'
            : 'snapshot-mismatch';
        return 'ok';
      } catch (e) {
        return safeError(e);
      }
    },
    async wait({ kind, label, target }) {
      if (kind === 'pending') await until(() => Boolean(job.status().pending));
      else if (kind === 'active') await until(() => job.status().active === handles.get(label));
      else if (kind === 'denied') await until(() => job.status().denied === handles.get(label));
      else if (kind === 'inactive') await until(() => job.status().active === null);
      else await until(() => counts[kind] === target);
    },
    matches({ request, jkt, label }) {
      return job.status().pending === request && requests.get(label)?.jkt === jkt;
    },
    status: () => ({
      active: Boolean(job.status().active),
      pending: Boolean(job.status().pending),
    }),
    close() {
      job.close();
      tray.stop();
    },
  };
  tray.start();
  await until(() => tray.status().state === 'ready');
  const leader = cert
    .getFingerprints()
    .find((f) => f.algorithm === 'sha-256')
    .value.replaceAll(':', '')
    .toLowerCase();
  return { url: tray.pairing().joinUrl, leader };
}

export async function localLeader(t, chrome) {
  const hub = await startHub();
  t.after(() => hub.close());
  const web = await serve({
    roots: [
      ['/fixture/', 'test/integration/lease-interop/'],
      ['/', 'src/'],
    ],
  });
  t.after(() => web.close());
  web.overrides.set('/seed/lease-build.js', leaseTestBuild);
  web.overrides.set('/blank.html', '<!doctype html><title>Isolated job fixture</title>');
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${web.url}blank.html`);
  const invoke = (method, p) => page.evaluate(([m, v]) => globalThis.probe[m](v), [method, p]);
  return {
    hub: hub.url,
    version: browser.version(),
    async start(broker) {
      return page.evaluate(install, { origin: hub.url, broker });
    },
    request: async (label, allow, from, want = 'ok') =>
      assert.equal(await invoke('request', { label, allow, from }), want),
    action: async (label, op, args = {}, want = 'ok', marker = 'Invoice 1042') =>
      assert.equal(await invoke('action', { label, op, args, marker }), want),
    wait: (kind, label, target) => invoke('wait', { kind, label, target }),
    matches: (p) => invoke('matches', p),
    status: () => invoke('status'),
    counts: () => page.evaluate(() => ({ ...probe.counts })),
    close: () => invoke('close'),
  };
}
