import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-state-fixture.mjs';

for (const path of ['a', 'b']) {
  for (const namespace of ['same', 'distinct']) {
    test(`state snapshot ${path} ${namespace}`, async (t) => {
      const wire = protocol(t);
      const root = namespace === 'same' ? 'snapshot' : 'snapshot-frame';
      const entry = wire.target('snapshot', 'page', plainFrame(root));
      const session = await wire.attach('snapshot');
      if (path === 'b')
        assert.equal(
          (await wire.send('Runtime.evaluate', { expression: 'history.back()' }, session)).error,
          undefined
        );
      entry.tree = { frame: errorFrame(root) };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-snapshot',
        params: { frame: entry.tree.frame },
      });
      const mark = wire.sent.length;
      const answer = await wire.send(
        'DOMSnapshot.captureSnapshot',
        { computedStyles: [] },
        session
      );
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
      assert.deepEqual(wire.clients(mark), []);
    });
  }
}

for (const unreachableUrl of [undefined, '', '://', null, {}]) {
  test(`state uncertain ${JSON.stringify(unreachableUrl)}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('uncertain');
    const session = await wire.attach('uncertain');
    entry.tree = { frame: { ...errorFrame('uncertain'), unreachableUrl } };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-uncertain',
      params: { frame: entry.tree.frame },
    });
    const answer = await wire.send('Runtime.evaluate', { expression: '1' }, session);
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
  });
}

test('state events and metadata', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('events');
  const session = await wire.attach('events');
  await wire.send('Runtime.enable', {}, session);
  entry.tree = { frame: errorFrame('events') };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-events',
    params: { frame: entry.tree.frame },
  });
  await flush();
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId: session,
    params: { type: 'log', args: [{ type: 'string', value: 'synthetic-withheld' }] },
  });
  wire.emit({
    method: 'DOM.childNodeInserted',
    sessionId: session,
    params: { node: { nodeId: 73, nodeName: 'synthetic-withheld' } },
  });
  wire.emit({
    method: 'Page.screencastFrame',
    sessionId: session,
    params: { data: 'synthetic-withheld' },
  });
  await flush();
  assert.equal(JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-withheld'), false);
  entry.info.url = `${failed}?query-marker=synthetic-query#synthetic-fragment`;
  entry.info.title = 'synthetic-protected-title';
  const listing = await wire.send('Target.getTargets');
  assert.equal(listing.error, undefined);
  assert.equal(listing.result?.targetInfos?.[0]?.url, new URL(failed).origin);
  assert.equal(listing.result?.targetInfos?.[0]?.title, new URL(failed).origin);
  assert.equal(JSON.stringify(listing).includes(failed), false);
  for (const marker of [
    new URL(failed).pathname,
    'synthetic-query',
    'synthetic-fragment',
    entry.info.title,
  ])
    assert.equal(JSON.stringify(listing).includes(marker), false);
});

test('state ordinary recovery', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('recovery');
  const session = await wire.attach('recovery');
  entry.tree = { frame: errorFrame('recovery') };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-recovery',
    params: { frame: entry.tree.frame },
  });
  assert.match(
    (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error?.message ?? '',
    /^slicc: refused:/
  );
  entry.tree = { frame: plainFrame('recovery') };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-recovery',
    params: { frame: entry.tree.frame },
  });
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
    undefined
  );
});

test('state existing document', async (t) => {
  const wire = protocol(t);
  wire.target('existing', 'page', errorFrame('existing'));
  const answer = await wire.send('Target.attachToTarget', { targetId: 'existing', flatten: true });
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
});

test('state initial metadata', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('initial-metadata', 'page', errorFrame('initial-metadata'));
  entry.info.title = failed;
  const answer = await wire.send('Target.getTargetInfo', { targetId: 'initial-metadata' });
  assert.equal(answer.error, undefined);
  assert.equal(answer.result.targetInfo.title, '');
  assert.equal(JSON.stringify(answer).includes(failed), false);
});

test('state absent evidence', async (t) => {
  const wire = protocol(t);
  wire.target('absent-evidence', 'page', {
    ...errorFrame('absent-evidence'),
    unreachableUrl: ordinary,
  });
  wire.hold((message) => message.method === 'Page.getFrameTree');
  const attaching = wire.request('Target.attachToTarget', {
    targetId: 'absent-evidence',
    flatten: true,
  });
  await flush();
  const proof = wire.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(proof);
  wire.release(proof, { error: { code: -32000, message: 'synthetic unavailable state' } });
  const answer = await attaching.answer;
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
});

test('state ordinary error and history controls', async (t) => {
  const wire = protocol(t);
  const frame = { ...errorFrame('ordinary-error'), unreachableUrl: ordinary };
  wire.target('ordinary-error', 'page', frame);
  const session = await wire.attach('ordinary-error');
  assert.equal(
    (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
    undefined
  );
  assert.equal(
    (await wire.send('Page.navigateToHistoryEntry', { entryId: 1 }, session)).error,
    undefined
  );
});
