import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootLeaseJob, createLeaseJob } from '../../src/seed/lease-job.js';
import { leaseFollowers } from '../../src/seed/lease-peer.js';
import { holderKey, openLease } from '../../src/seed/lease-wire.js';
import { createLeaseTray } from '../../src/seed/tray.js';

const fixture = {
  origin: 'https://tray.example',
  broker: '0'.repeat(64),
  certificate: {},
  job: {},
  CDP_LEASE_VERSION: 1,
  LEASE_PRODUCT_VERSION: 1,
  createKernel: assert.fail,
  makePeer: assert.fail,
  fetch: assert.fail,
};
const disabled = { reason: 'E_UNSUPPORTED', message: 'Browser leases are disabled in this build.' };

test('the shipped job constructor is disabled even with a caller-supplied version', async () => {
  await assert.rejects(createLeaseJob('job', fixture), disabled);
});
test('the shipped tray constructor refuses before signaling', () => {
  assert.throws(
    () =>
      createLeaseTray({
        ...fixture,
        get origin() {
          return assert.fail('disabled constructor read its hub config');
        },
      }),
    disabled
  );
});
test('the shipped holder key factory does not generate crypto material', async () => {
  await assert.rejects(holderKey(), disabled);
});
test('the shipped stream opener refuses before touching session or key', async () => {
  await assert.rejects(
    openLease({ open: assert.fail }, { proof: assert.fail }, {}, new AbortController().signal),
    disabled
  );
});
test('the shipped follower constructor refuses before a peer can be started', () => {
  assert.throws(() => leaseFollowers(fixture), disabled);
});
test('the public boot path also requires the product build gate', async () => {
  await assert.rejects(
    bootLeaseJob(fixture, {
      ...fixture,
      get root() {
        return assert.fail('disabled boot read the job root');
      },
    }),
    disabled
  );
});
