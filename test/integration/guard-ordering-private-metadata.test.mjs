import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-ordering-fixture.mjs';

for (const method of ['Target.targetInfoChanged', 'Target.targetCreated']) {
  test(`all-private-errors withholds unconfirmed ${method}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('unconfirmed', 'page', errorFrame('unconfirmed'));
    entry.info.title = 'synthetic-pending';
    wire.privateFailure(true);
    wire.attached('unconfirmed');
    await flush();
    await flush();
    entry.info.title = failed;
    if (method === 'Target.targetCreated')
      await wire.send('Target.setDiscoverTargets', { discover: true });
    const mark = wire.delivered.length;
    wire.emit({ method, params: { targetInfo: entry.info } });
    await flush();
    const published = wire.delivered.slice(mark);
    wire.privateFailure(false);
    entry.info = { ...entry.info, url: ordinary, title: 'ordinary' };
    entry.tree = { frame: plainFrame('unconfirmed') };
    const session = wire.attached('unconfirmed');
    await flush();
    await flush();
    const recovered = await wire.send('Runtime.evaluate', { expression: '1' }, session);
    assert.equal(recovered.error, undefined, 'ordinary independent verification can recover');
    const ordinaryMark = wire.delivered.length;
    wire.emit({ method, params: { targetInfo: entry.info } });
    await flush();
    assert.ok(
      wire.delivered
        .slice(ordinaryMark)
        .some(
          (message) => message.method === method && message.params.targetInfo.title === 'ordinary'
        ),
      'confirmed ordinary target metadata remains observable'
    );
    assert.equal(
      JSON.stringify(published).includes(failed),
      false,
      'the synthetic private title remains withheld'
    );
  });
}
