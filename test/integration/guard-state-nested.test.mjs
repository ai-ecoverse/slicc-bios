import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, protocol } from './guard-state-fixture.mjs';

for (const location of ['details', 'array', 'key']) {
  test(`state nested event ${location}`, async (t) => {
    const wire = protocol(t);
    wire.target('nested-owner');
    const session = await wire.attach('nested-owner');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-nested-owner',
      params: { frame: errorFrame('nested-unsafe', 'nested-owner') },
    });
    await flush();
    const mark = wire.delivered.length;
    const details =
      location === 'details'
        ? { genericIssueDetails: { request: { frameId: 'nested-unsafe' } } }
        : location === 'array'
          ? { affectedFrames: [{ metadata: ['nested-unsafe'] }] }
          : { affectedFrames: { 'nested-unsafe': { visible: true } } };
    wire.emit({
      method: 'Audits.issueAdded',
      sessionId: session,
      params: { issue: { code: 'GenericIssue', details }, extra: 'synthetic-nested-private' },
    });
    await flush();
    assert.equal(
      wire.delivered.slice(mark).some((message) => message.method === 'Audits.issueAdded'),
      false
    );
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-nested-private'),
      false
    );
  });
}

test('state nested ordinary controls', async (t) => {
  const wire = protocol(t);
  wire.target('nested-positive');
  const session = await wire.attach('nested-positive');
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Audits.issueAdded',
    sessionId: session,
    params: {
      issue: {
        code: 'GenericIssue',
        details: { affectedFrames: [{ frameId: 'nested-positive' }] },
      },
    },
  });
  await flush();
  assert.ok(wire.delivered.slice(mark).some((message) => message.method === 'Audits.issueAdded'));
});

test('state nested budget remains closed', async (t) => {
  const wire = protocol(t);
  wire.target('nested-budget');
  const session = await wire.attach('nested-budget');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-nested-budget',
    params: { frame: errorFrame('nested-budget-unsafe', 'nested-budget') },
  });
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Audits.issueAdded',
    sessionId: session,
    params: {
      issue: {
        code: 'GenericIssue',
        details: { values: Array(4100).fill('synthetic-budget-data') },
      },
    },
  });
  await flush();
  assert.equal(
    wire.delivered.slice(mark).some((message) => message.method === 'Audits.issueAdded'),
    false
  );
});
