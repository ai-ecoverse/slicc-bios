import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stage1ClientRow, stage1RowFailures } from './fixtures/cdp-675-stage1-client.mjs';

const rescue = {
  origin: 'guard',
  noObserverResume: true,
  ownerUnchanged: true,
  generationUnchanged: true,
  deadlineUnchanged: true,
};
const row = {
  id: 'pending-protected-hop',
  mode: 'pending-pause-hop',
  expected: { admitted: true, published: false, committed: false, released: true },
  requires: ['privateRescueAudit'],
};

function pendingFixture() {
  const methods = [];
  const phases = [];
  let enabled = false;
  let acknowledge;
  const client = {
    events: [],
    async send(method) {
      methods.push(method);
      if (method === 'Debugger.pause' && !enabled)
        throw new Error('slicc: refused: no owned pause');
      if (method === 'Debugger.enable') enabled = true;
      if (method === 'Debugger.setInstrumentationBreakpoint') return { breakpointId: 'breakpoint' };
      if (method === 'Debugger.pause')
        return new Promise((resolve) => {
          acknowledge = resolve;
        });
      return {};
    },
  };
  return {
    row,
    client,
    session: 'session',
    budget: 100,
    navigate: async (_, phase) => {
      phases.push(phase);
      if (phase === 'ordinary')
        client.events.push({
          sessionId: 'session',
          method: 'Debugger.paused',
          params: {
            reason: 'instrumentation',
            callFrames: [{ callFrameId: 'frame', location: { scriptId: 'script' } }],
          },
        });
      if (phase === 'pending-pause') acknowledge({});
      return { stimulated: true };
    },
    read: async () => ({ committed: false, released: true }),
    audit: async () => rescue,
    methods,
    phases,
  };
}

test('the protected pending-pause row really holds a conversion acknowledgement across the hop', async () => {
  const fixture = pendingFixture();
  const result = await stage1ClientRow(fixture);
  assert.deepEqual(fixture.phases, ['ordinary', 'pending-pause']);
  assert.deepEqual(stage1RowFailures(row, result, rescue), []);
  assert.equal(result.trace.filter((entry) => entry.method === 'Debugger.pause').length, 2);
});

test('a pending-pause landing or event leak cannot count as a safe row', async () => {
  const fixture = pendingFixture();
  fixture.read = async () => ({ committed: true, released: true });
  const navigate = fixture.navigate;
  fixture.navigate = async (input, phase) => {
    const result = await navigate(input, phase);
    if (phase === 'pending-pause')
      fixture.client.events.push({
        sessionId: 'session',
        method: 'Debugger.paused',
        params: { reason: 'other' },
      });
    return result;
  };
  const result = await stage1ClientRow(fixture);
  assert.deepEqual(stage1RowFailures(row, result, rescue), ['published', 'committed']);
});

test('a setup that never actually stimulates navigation is a setup failure', async () => {
  const fixture = pendingFixture();
  fixture.navigate = async () => ({ stimulated: false });
  await assert.rejects(stage1ClientRow(fixture), /navigation was not stimulated/);
});
