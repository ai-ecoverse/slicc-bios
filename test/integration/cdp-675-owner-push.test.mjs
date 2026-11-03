import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerPushFixture } from './cdp-675-owner-push-fixture.mjs';

test('owner-push row waits for asynchronous scrubbed delivery to this client before sampling and preserves the prior node', async () => {
  const fixture = ownerPushFixture();
  await fixture.run();
  assert.equal(fixture.waited, true);
  assert.ok(
    fixture.row.privateOwnerPushes.some(
      ({ boundary, packet }) => boundary === 'bios' && packet.sessionId === 'client'
    )
  );
  assert.equal(fixture.calls.at(-1).method, 'DOM.querySelectorAll');
  assert.equal(fixture.calls.at(-1).params.nodeId, 17);
  assert.equal(fixture.closed, true);
});

for (const [options, error] of [
  [{ boundOwner: true }, /owner unbound/],
  [{ missingPush: true }, /wait expired/],
  [{ protectedPush: true }, /not match/],
]) {
  test(`owner-push row still rejects ${Object.keys(options)[0]} rather than weakening the premise or scrub`, async () => {
    const fixture = ownerPushFixture(options);
    await assert.rejects(fixture.run(), error);
  });
}

test('root-only node-preservation row does not require an owner push', async () => {
  const fixture = ownerPushFixture();
  await fixture.run({ privateOwnerPush: false });
  assert.equal(fixture.waited, false);
  assert.equal(fixture.calls.at(-1).params.nodeId, 17);
  assert.equal(fixture.closed, true);
});
