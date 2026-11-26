import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { findBrowser } from '@ai-ecoverse/slicc-cdp';
import { serve } from '@ai-ecoverse/slicc-shared-web/harness';
import { chromium } from 'playwright-core';
import { grantFor, proposal as makeProposal } from '../../src/seed/lease-scope.js';
import { fields, proofBytes, records } from '../../src/seed/lease-wire.js';
import { startHub } from './fake-hub.mjs';
import { leaseTestBuild } from './lease-test-build.mjs';

const site = 'https://billing.example';
const proposal = { allow: [{ kind: 'origin', url: site }], ttlSeconds: 3600 };

test('real local WebRTC: pending is not access, peer pin and holder proof, site/expiry boundaries, reconnect requires new approval', {
  timeout: 45000,
}, async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const local = await serve({
    roots: [
      ['/fixture/', 'test/integration/fixtures/'],
      ['/', 'src/'],
    ],
  });
  t.after(() => local.close());
  local.overrides.set('/seed/lease-build.js', leaseTestBuild);
  local.overrides.set('/blank.html', '<!doctype html><title>Isolated fixture</title>');
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (await findBrowser())?.executable,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const owner = await browser.newPage();
  await Promise.all([page.goto(`${local.url}blank.html`), owner.goto(`${local.url}blank.html`)]);
  const pin = await owner.evaluate(async () => {
    const { broker } = await import('/fixture/lease-broker.mjs');
    globalThis.fixtureBroker = await broker();
    globalThis.wrongBroker = await broker();
    return fixtureBroker.fingerprint;
  });
  const start = await page.evaluate(
    async ({ pin, hub, proposal }) => {
      const { createLeaseJob } = await import('/seed/lease-job.js');
      const { createLeaseTray } = await import('/seed/tray.js');
      const cert = await RTCPeerConnection.generateCertificate({
        name: 'ECDSA',
        namedCurve: 'P-256',
      });
      globalThis.clock = Date.now();
      const job = await createLeaseJob('fixture', { now: () => clock });
      globalThis.attached = Promise.withResolvers();
      const tray = createLeaseTray({
        origin: hub,
        broker: pin,
        certificate: cert,
        job: {
          attach(s) {
            job.attach(s);
            attached.resolve();
          },
          detach: job.detach,
        },
      });
      const ctx = { stamp: { tag: 'fixture' }, signal: new AbortController().signal };
      const request = await job.adapter.request(proposal, ctx);
      globalThis.ask = () => job.adapter.request(proposal, ctx);
      globalThis.state = job.status;
      globalThis.act = async (op, args, lease = request.lease) => {
        try {
          return await job.adapter.action({ lease, op, args }, ctx);
        } catch (e) {
          return { reason: e.reason, message: e.message };
        }
      };
      const ready = new Promise((resolve) => {
        const off = tray.on(() => {
          if (tray.status().state === 'ready') {
            off();
            resolve();
          }
        });
      });
      tray.start();
      await ready;
      globalThis.stopLease = () => {
        job.close();
        tray.stop();
      };
      return {
        url: tray.pairing().joinUrl,
        lease: request.lease,
        jkt: request.jkt,
        leader: cert
          .getFingerprints()
          .find((f) => f.algorithm === 'sha-256')
          .value.replaceAll(':', '')
          .toLowerCase(),
        exp: Math.floor(clock / 1000) + 60,
      };
    },
    { pin, hub: hub.url, proposal }
  );
  const action = (op, args = {}, lease = start.lease) =>
    page.evaluate(([op, args, lease]) => act(op, args, lease), [op, args, lease]);
  assert.equal((await action('snapshot')).reason, 'E_PENDING');
  const attempted = await owner.evaluate(async ({ url, jkt, leader }) => {
    try {
      await wrongBroker.connect(url, jkt, leader);
      return 'connected';
    } catch (e) {
      return e.code;
    }
  }, start);
  assert.equal(attempted, 'UNTRUSTED');
  assert.deepEqual(await owner.evaluate(() => wrongBroker.nonces), []);
  assert.equal(await page.evaluate(() => state().active), null);
  assert.equal((await action('snapshot')).reason, 'E_PENDING');
  const connect = () =>
    owner.evaluate(({ url, jkt, leader }) => fixtureBroker.connect(url, jkt, leader), start);
  assert.deepEqual(await connect(), ['cdp-lease-v1']);
  await owner.evaluate(() => fixtureBroker.pending);
  assert.equal((await action('snapshot')).reason, 'E_PENDING');
  assert.deepEqual(
    await owner.evaluate(async () =>
      Promise.all(
        ['cdp', 'tcp', 'kernel', 'agent', 'fs', 'cdp-lease-v1'].map(async (kind) => {
          try {
            await fixtureBroker.raw(kind);
            return null;
          } catch (e) {
            return e.code;
          }
        })
      )
    ),
    Array(6).fill('EOPNOTSUPP')
  );
  await owner.evaluate((exp) => fixtureBroker.approve(exp), start.exp);
  assert.deepEqual(await action('goto', { url: `${site}/app#invoice` }), { result: {} });
  assert.deepEqual(await action('snapshot'), { result: { text: 'Invoice 1042' } });
  assert.equal(
    (await action('goto', { url: 'https://receipts.example/r/1042' })).reason,
    'E_SCOPE'
  );
  const outside = await action('click', { ref: 'e2' });
  assert.equal(outside.reason, 'E_UNSUPPORTED');
  assert.doesNotMatch(outside.message, /redirect/);
  assert.equal((await action('Runtime.evaluate', { expression: '1' })).reason, 'E_UNSUPPORTED');
  assert.equal((await action('fill', { ref: 'e1', value: 'fixture' })).reason, 'E_UNSUPPORTED');
  await page.evaluate(() => {
    globalThis.attached = Promise.withResolvers();
  });
  await owner.evaluate(() => fixtureBroker.disconnect());
  assert.deepEqual(await connect(), ['cdp-lease-v1']);
  await page.evaluate(() => attached.promise);
  assert.equal(await page.evaluate(() => state().active), null);
  assert.equal((await action('snapshot')).reason, 'E_REVOKED');
  assert.deepEqual(await owner.evaluate(() => fixtureBroker.nonces.map((n) => n.mode)), [
    'request',
    'data',
  ]);
  const next = await page.evaluate(() => ask());
  assert.notEqual(next.lease, start.lease);
  await owner.evaluate(() => fixtureBroker.pending);
  assert.equal((await action('snapshot', {}, next.lease)).reason, 'E_PENDING');
  await owner.evaluate((exp) => fixtureBroker.approve(exp), start.exp);
  assert.deepEqual(await action('snapshot', {}, next.lease), { result: { text: 'Invoice 1042' } });
  const nonces = await owner.evaluate(() => fixtureBroker.nonces);
  assert.deepEqual(
    nonces.map((n) => n.mode),
    ['request', 'data', 'request', 'data']
  );
  assert.equal(new Set(nonces.map((n) => n.nonce)).size, 4);
  await page.evaluate((exp) => {
    globalThis.clock = exp * 1000;
  }, start.exp);
  assert.equal((await action('snapshot', {}, next.lease)).reason, 'E_EXPIRED');
  assert.deepEqual(await owner.evaluate(() => fixtureBroker.actions), [
    'goto',
    'snapshot',
    'snapshot',
  ]);
  assert.doesNotMatch(
    JSON.stringify(hub.fromLeader),
    /"jwt"|"jwk"|"proof"|"leaseRequest"|billing\.example/
  );
  await page.evaluate(() => stopLease());
});

test('independent shared-v1 signing inputs and length-prefixed record bytes', {
  skip: !process.env.SLICC_LEASE_VECTORS,
}, async () => {
  const v = JSON.parse(await readFile(process.env.SLICC_LEASE_VECTORS, 'utf8'));
  for (const stream of [v.requestStream, v.dataStream]) {
    const bytes = await proofBytes(stream.opened.nonce, v.holderJwk, stream.open.jwt);
    assert.equal(bytes.toHex(), stream.transcriptHex);
    const key = await crypto.subtle.importKey('jwk', v.holderJwk, 'Ed25519', false, ['verify']);
    assert.ok(
      await crypto.subtle.verify('Ed25519', key, Buffer.from(stream.proof.sig, 'base64url'), bytes)
    );
    await records({ write: (bytes) => assert.equal(bytes.toHex(), stream.proofRecordHex) }).write(
      stream.proof
    );
  }
  assert.deepEqual(fields(v.jwt), v.claims);
  for (const id of ['unsigned', 'alg-ed-dsa', 'unexpected-typ', 'key-url', 'supplied-key'])
    assert.throws(() => fields(v.jwtCases.find((item) => item.id === id).jwt));
  const now = v.context.now * 1000;
  const parent = grantFor(v.jwt, v.claims.cnf.jkt, v.requestStream.open, undefined, now);
  const { kind: _kind, jwk: _jwk, ...offer } = v.expansion.open;
  assert.deepEqual(makeProposal({ lease: 'local', allow: offer.allow }, parent), offer);
  assert.equal(
    grantFor(v.expansion.grant.jwt, v.claims.cnf.jkt, offer, parent, now).exp,
    parent.exp
  );
  assert.throws(() =>
    makeProposal({ lease: 'local', allow: offer.allow, ttlSeconds: 3600 }, parent)
  );
});
