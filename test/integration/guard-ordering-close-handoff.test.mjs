import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import {
  failed,
  flush,
  ordinary,
  protectedOrigin,
  recoveryProtocol,
} from './guard-recovery-fixture.mjs';

function gate(t) {
  let release;
  let requested;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    requested = resolve;
  });
  t.after(release);
  return { ready, seen, release, requested };
}

for (const outcome of [
  'owned error',
  'owned ordinary',
  'owned refusal',
  'client refusal',
  'client deadline',
  'guardian deadline',
  'guardian detached',
]) {
  test(`close completes an admitted client's private proof handoff: ${outcome}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = recoveryProtocol(t);
    const id = 'close-handoff';
    const entry = wire.target(id);
    const ordinaryTree = structuredClone(entry.tree);
    const client = await wire.connect();
    const session = await client.attach(id);
    assert.equal((await client.send('Page.enable', {}, session)).error, undefined);
    const owner = wire.calls.find((call) => call.method === 'Fetch.enable')?.sessionId;
    assert.ok(owner);
    const caller = gate(t);
    const guardian = gate(t);
    let hinted = false;
    wire.trees(async (current, reader) => {
      if (reader === session) {
        caller.requested();
        await caller.ready;
        if (outcome === 'client refusal') throw new Error('client tree unavailable');
        hinted = true;
        return current.tree;
      }
      if (reader === owner && hinted) {
        guardian.requested();
        await guardian.ready;
        if (outcome === 'owned refusal') throw new Error('owned tree unavailable');
        return outcome === 'owned ordinary' ? ordinaryTree : current.tree;
      }
      return ordinaryTree;
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    wire.blocked(id, false);
    await caller.seen;
    assert.equal(
      wire.calls.some(
        (call) => call.method === 'Page.getFrameTree' && call.sessionId === owner && hinted
      ),
      false
    );
    assert.equal(
      (await client.send('Target.detachFromTarget', { sessionId: session })).error,
      undefined
    );
    const mark = wire.calls.length;
    const delivered = client.delivered.length;
    const detached = () =>
      wire.calls
        .slice(mark)
        .filter(
          (call) => call.method === 'Target.detachFromTarget' && call.params.sessionId === owner
        );
    client.close();
    await flush();
    assert.equal(detached().length, 0, 'the already-started caller proof is drained');
    if (outcome === 'client deadline') {
      t.mock.timers.tick(5000);
      await flush();
      assert.equal(detached().length, 1);
      caller.release();
      await flush();
      assert.equal(hinted, true);
      assert.equal(
        wire.calls.slice(mark).some((call) => call.method === 'Page.getFrameTree'),
        false,
        'a caller reply after the bound cannot start a guardian proof'
      );
    } else {
      if (outcome === 'guardian detached')
        wire.emit({ method: 'Target.detachedFromTarget', params: { sessionId: owner } });
      caller.release();
      await flush();
      await flush();
      if (!['client refusal', 'guardian detached'].includes(outcome)) {
        await guardian.seen;
        assert.equal(detached().length, 0, 'the handoff retains only its required private proof');
        if (outcome === 'guardian deadline') {
          t.mock.timers.tick(5000);
          await flush();
          assert.equal(detached().length, 1);
        }
      }
      guardian.release();
      await flush();
      await flush();
      assert.equal(
        detached().length,
        1,
        'transport close follows settlement or the existing bound'
      );
    }
    assert.equal(client.delivered.length, delivered, 'closed clients receive no late messages');
    const next = await wire.connect();
    const info = await next.send('Target.getTargetInfo', { targetId: id });
    if (outcome !== 'owned error') {
      assert.equal(info.error?.message, PROTECTED);
      assert.equal(info.result, undefined);
      return;
    }
    assert.equal(info.error, undefined);
    assert.equal(info.result.targetInfo.url, protectedOrigin);
    const recovered = await next.attach(id);
    assert.equal((await next.send('Runtime.evaluate', {}, recovered)).error?.message, PROTECTED);
    const destination = `${ordinary}?after=handoff`;
    assert.equal(
      (await next.send('Page.navigate', { url: destination }, recovered)).error,
      undefined
    );
    const read = await next.send('Runtime.evaluate', {}, recovered);
    assert.equal(read.error, undefined);
    assert.equal(read.result.result.value, `${destination} recovered`);
    const snapshot = await next.send('Accessibility.getFullAXTree', {}, recovered);
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.result.nodes[0].name.value, 'recovered');
    assert.equal(entry.info.url, destination);
    assert.notEqual(entry.info.url, failed);
  });
}
