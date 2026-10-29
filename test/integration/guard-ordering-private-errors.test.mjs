import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

for (const type of ['page', 'iframe', 'worker', 'service_worker', 'shared_worker']) {
  test(`ordering private failure ${type}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('unconfirmed', type);
    entry.info.title = failed;
    wire.privateFailure(true);
    const session = wire.attached('unconfirmed');
    await flush();
    await flush();
    const mark = wire.sent.length;
    const first = await wire.send('Runtime.evaluate', { expression: '1+1' }, session);
    const forwarded = wire.clients(mark);
    const published = wire.delivered.some(
      (message) =>
        message.method === 'Target.attachedToTarget' && message.params.sessionId === session
    );
    const exposed = JSON.stringify(wire.delivered).includes(failed);
    wire.privateFailure(false);
    entry.info.title = 'ordinary';
    entry.tree = { frame: plainFrame('unconfirmed') };
    wire.attached('unconfirmed');
    await flush();
    await flush();
    const recovered = await wire.send('Runtime.evaluate', { expression: '1+1' }, session);
    assert.equal(published, false, 'failed private checks publish no attachment');
    assert.equal(exposed, false);
    assert.deepEqual(forwarded, [], 'failed private checks forward no content');
    assert.match(first.error?.message ?? '', /^slicc: refused:/);
    assert.equal(first.result, undefined);
    assert.equal(
      recovered.error,
      undefined,
      'ordinary attachments can retry a successful independent check'
    );
    assert.equal(recovered.result?.result?.value, 'synthetic-content');
  });
}
