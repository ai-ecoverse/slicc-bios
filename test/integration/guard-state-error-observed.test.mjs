import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-state-fixture.mjs';

for (const namespace of ['same', 'distinct']) {
  test(`a fresh protected error proof starts the scrub without a published commit ${namespace}`, async (t) => {
    const wire = protocol(t);
    const id = 'observed-error';
    const root = namespace === 'same' ? id : 'observed-root';
    const entry = wire.target(id, 'page', plainFrame(root));
    const session = await wire.attach(id);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    entry.tree.frame = { ...errorFrame(root), loaderId: 'observed-error-loader' };
    entry.info.url = failed;
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    const info = await wire.send('Target.getTargetInfo', { targetId: id });
    assert.equal(info.error, undefined);
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
    await wire.send('Page.getNavigationHistory', {}, session);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(
      wire.sent.filter(
        (message) => message.method === 'Page.navigate' && message.params.url === BLANKED
      ).length,
      1
    );
  });
}

test('an observed ordinary error is not a protected-document scrub', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('observed-ordinary');
  await wire.attach('observed-ordinary');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  entry.tree.frame = { ...errorFrame('observed-ordinary'), unreachableUrl: ordinary };
  entry.info.url = failed;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  assert.equal(
    (await wire.send('Target.getTargetInfo', { targetId: 'observed-ordinary' })).error,
    undefined
  );
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(
    wire.sent.some(
      (message) => message.method === 'Page.navigate' && message.params.url === BLANKED
    ),
    false
  );
});
