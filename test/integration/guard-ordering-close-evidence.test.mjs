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

async function closingProof(t, outcome) {
  const wire = recoveryProtocol(t);
  const id = 'closing-proof';
  const entry = wire.target(id);
  const client = await wire.connect();
  const session = await client.attach(id);
  assert.equal((await client.send('Page.enable', {}, session)).error, undefined);
  const owner = wire.calls.find((call) => call.method === 'Fetch.enable')?.sessionId;
  assert.ok(owner);
  const errorTree = {
    frame: {
      ...entry.tree.frame,
      url: 'chrome-error://chromewebdata/',
      securityOrigin: '://',
      unreachableUrl: failed,
      loaderId: 'closing-error-loader',
    },
  };
  let hinted = false;
  let release;
  let requested;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const observed = new Promise((resolve) => {
    requested = resolve;
  });
  t.after(release);
  wire.trees(async (current, caller) => {
    if (caller === session) {
      hinted = true;
      return errorTree;
    }
    if (caller === owner && hinted) {
      requested();
      await ready;
      if (outcome === 'error') throw new Error('owned proof failed');
      return errorTree;
    }
    return current.tree;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  void client.send('Runtime.evaluate', { expression: '1' }, session);
  await observed;
  entry.info = { ...entry.info, url: failed };
  entry.tree = errorTree;
  const mark = wire.calls.length;
  const delivered = client.delivered.length;
  client.close();
  await flush();
  return { wire, client, id, owner, release, mark, delivered };
}

for (const outcome of ['slow', 'error', 'missing']) {
  test(`an admitted tab's owned proof settles across close or fails closed: ${outcome}`, {
    timeout: 5000,
  }, async (t) => {
    const { wire, client, id, owner, release, mark, delivered } = await closingProof(t, outcome);
    const detached = () =>
      wire.calls
        .slice(mark)
        .filter(
          (call) => call.method === 'Target.detachFromTarget' && call.params.sessionId === owner
        );
    let earlyDetach;
    if (outcome === 'missing') {
      assert.equal(detached().length, 0, 'close retains the owned proof connection');
      t.mock.timers.tick(4999);
      await flush();
      assert.equal(detached().length, 0);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(detached().length, 1, 'a dead connection cannot hold close forever');
      release();
      await flush();
      t.mock.timers.tick(5000);
      await flush();
    } else {
      t.mock.timers.tick(100);
      await flush();
      earlyDetach = detached().length;
      release();
      await flush();
      await flush();
      assert.equal(detached().length, 1, 'close finishes after the owned proof settles');
    }
    assert.equal(client.delivered.length, delivered, 'closed clients receive no late content');
    const next = await wire.connect();
    const info = await next.send('Target.getTargetInfo', { targetId: id });
    if (outcome !== 'slow') {
      assert.equal(info.error?.message, PROTECTED);
      assert.equal(info.result, undefined);
      return;
    }
    assert.equal(info.error, undefined);
    assert.equal(info.result.targetInfo.url, protectedOrigin);
    assert.equal(earlyDetach, 0, 'close retained the owned proof connection until its reply');
    const session = await next.attach(id);
    assert.equal((await next.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
    const destination = `${ordinary}?after=close`;
    assert.equal(
      (await next.send('Page.navigate', { url: destination }, session)).error,
      undefined
    );
    const reading = await next.send('Runtime.evaluate', { expression: 'location.href' }, session);
    assert.equal(reading.error, undefined);
    assert.equal(reading.result.result.value, `${destination} recovered`);
    const snapshot = await next.send('Accessibility.getFullAXTree', {}, session);
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.result.nodes[0].name.value, 'recovered');
  });
}
