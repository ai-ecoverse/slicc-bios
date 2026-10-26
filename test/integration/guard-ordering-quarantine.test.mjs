import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

test('ordering owned child quarantine requires a verified harmless document before parent recovery', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const parentEntry = wire.target('quarantine-parent');
  const parent = await wire.attach('quarantine-parent');
  const childEntry = wire.target(
    'quarantine-child',
    'iframe',
    plainFrame('quarantine-child', 'quarantine-parent'),
    'quarantine-parent'
  );
  parentEntry.tree.childFrames = [{ frame: childEntry.tree.frame }];
  const child = wire.attached('quarantine-child', parent);
  await flush();
  await flush();
  await wire.send('Runtime.evaluate', { expression: '1' }, parent);
  childEntry.tree = { frame: errorFrame('quarantine-child', 'quarantine-parent') };
  childEntry.info.title = failed;
  parentEntry.tree.childFrames = [childEntry.tree];
  wire.hold((message) => message.id >= 2 ** 30 && message.method === 'Page.navigate');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-quarantine-parent',
    params: { frame: childEntry.tree.frame },
  });
  await flush();
  const navigate = wire.held.find((message) => message.method === 'Page.navigate');
  assert.ok(navigate);
  assert.equal(navigate.sessionId, 'guard-quarantine-child');
  assert.equal(navigate.params.frameId, 'quarantine-child');
  assert.equal(navigate.params.url, BLANKED);
  assert.equal(
    wire.delivered.some(
      (message) =>
        message.method === 'Target.detachedFromTarget' && message.params.sessionId === child
    ),
    false
  );
  const blank = {
    ...plainFrame('quarantine-child', 'quarantine-parent'),
    url: BLANKED,
    securityOrigin: '://',
  };
  childEntry.tree = { frame: blank };
  parentEntry.tree.childFrames = [childEntry.tree];
  wire.hold(() => false);
  wire.release(navigate, { result: { frameId: 'quarantine-child' } });
  await flush();
  const mark = wire.sent.length;
  const childRead = await wire.send('Runtime.evaluate', { expression: 'loadTimeData' }, child);
  assert.match(childRead.error?.message ?? '', /^slicc: refused:/);
  assert.deepEqual(wire.clients(mark), []);
  for (const method of ['Runtime.evaluate', 'DOM.getDocument', 'Page.captureScreenshot']) {
    const answer = await wire.send(method, {}, parent);
    assert.equal(
      answer.error,
      undefined,
      'the unchanged parent is usable only after the owned whole tree proves the fixed blank child'
    );
  }
  const info = await wire.send('Target.getTargetInfo', { targetId: 'quarantine-child' });
  assert.equal(JSON.stringify(info).includes(failed), false);
  assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
});
