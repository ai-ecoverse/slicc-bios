import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localJob } from './lease-candidate.mjs';

const dist = process.env.SLICC_LEASE_KERNEL_DIST;
const wasm = process.env.SLICC_LEASE_CDP_WASM;

test('cross-branch: real job kernel and WASI request and consume only scoped actions on the pinned tray link', {
  timeout: 120000,
  skip: !(dist && wasm),
}, async (t) => {
  const job = await localJob(t, { dist, wasm });
  const owner = await job.browser.newPage();
  await owner.goto(`${job.url}blank.html`);
  const pin = await owner.evaluate(async () => {
    globalThis.b = await (await import('/fixture/lease-broker.mjs')).broker();
    return b.fingerprint;
  });
  const url = await job.start(pin);
  const { jkt, lease } = await job.request();
  const action = (...args) => job.run('--lease', lease, ...args);
  const before = await action('snapshot');
  assert.notEqual(before.status, 0);
  assert.equal(JSON.parse(before.stderr).reason, 'E_PENDING');
  assert.deepEqual(
    await owner.evaluate(({ url, jkt, leader }) => b.connect(url, jkt, leader), {
      url,
      jkt,
      leader: job.leaderPin,
    }),
    ['cdp-lease-v1']
  );
  await owner.evaluate(async () => {
    await b.pending;
    await b.approve(Math.floor(Date.now() / 1000) + 60);
  });
  const goto = await action('goto', 'https://billing.example/invoices');
  assert.equal(goto.status, 0, goto.stderr);
  assert.equal((await action('snapshot')).stdout.trim(), 'Invoice 1042');
  const raw = await job.run('--runtime', 'other-browser', 'snapshot');
  assert.notEqual(raw.status, 0, 'an unrelated runtime must not provide a browser');
  const mixed = await job.run('--lease', lease, '--runtime', 'other-browser', 'snapshot');
  assert.notEqual(mixed.status, 0, 'a lease handle cannot select another host');
  assert.deepEqual(await owner.evaluate(() => b.actions), ['goto', 'snapshot']);
  const outside = await action('goto', 'https://receipts.example/r/1042');
  assert.notEqual(outside.status, 0);
  assert.equal(JSON.parse(outside.stderr).reason, 'E_SCOPE');
  await job.page.evaluate(() => stopJob());
});
