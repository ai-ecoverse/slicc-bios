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
const install = {
  id: 'ordinary-install',
  mode: 'install',
  expected: { admitted: true, converted: true, liveReads: true, released: true },
  requires: ['privateRescueAudit'],
};

function fixture(overrides = {}) {
  const state = { resumed: false, disabled: false, converted: false };
  const frame = {
    callFrameId: 'frame',
    location: { scriptId: 'script', lineNumber: 0, columnNumber: 0 },
  };
  const client = {
    events: [],
    async send(method) {
      if (method === 'Debugger.pause' && !state.enabled)
        throw new Error(overrides.freeError ?? 'slicc: refused: no guard-owned pause');
      if (method === 'Debugger.enable') {
        if (overrides.oldBoundary) throw new Error('slicc: refused: Debugger');
        state.enabled = true;
      }
      if (method === 'Debugger.setInstrumentationBreakpoint')
        return { breakpointId: 'instrumentation' };
      if (method === 'Debugger.pause') state.converted = true;
      if (method === 'Debugger.resume') {
        if (state.converted) {
          state.converted = false;
          client.events.push({
            sessionId: 'session',
            method: 'Debugger.paused',
            params: { reason: 'other', callFrames: [frame] },
          });
        } else state.resumed = true;
      }
      if (method === 'Debugger.getScriptSource')
        return { scriptSource: 'globalThis.stage1Effect = 1' };
      if (method === 'Debugger.evaluateOnCallFrame') return { result: { value: 42 } };
      if (method === 'Debugger.disable') state.disabled = true;
      return {};
    },
  };
  return {
    client,
    session: 'session',
    budget: 100,
    navigate: async (row) => {
      if (row.mode === 'protected-hop') {
        if (overrides.leak)
          client.events.push({
            sessionId: 'session',
            method: 'Debugger.scriptParsed',
            params: { scriptId: 'error-page' },
          });
      } else
        client.events.push({
          sessionId: 'session',
          method: 'Debugger.paused',
          params: { reason: 'instrumentation', callFrames: [frame] },
        });
      return { stimulated: true };
    },
    read: async () => ({
      ordinary: true,
      generationCurrent: overrides.stale !== true,
      committed: false,
      released: state.resumed || overrides.protectedReleased === true,
    }),
    audit: async () => overrides.audit ?? rescue,
    lifecycle: async () => {
      state.resumed = true;
    },
    state,
  };
}

test('the executable admission row fails on an old blanket-refusing boundary without fallback', async () => {
  const input = fixture({ oldBoundary: true });
  await assert.rejects(stage1ClientRow({ ...input, row: install }), /refused: Debugger/);
  assert.equal(input.client.events.length, 0);
});

test('the admission row sends the seven methods and only converts an instrumentation pause', async () => {
  const input = fixture();
  const result = await stage1ClientRow({ ...input, row: install });
  assert.deepEqual(stage1RowFailures(install, result, rescue), []);
  assert.deepEqual(
    result.trace.map((entry) => entry.method),
    [
      'Debugger.pause',
      'Debugger.enable',
      'Debugger.setInstrumentationBreakpoint',
      'Debugger.pause',
      'Debugger.resume',
      'Page.getFrameTree',
      'Debugger.getScriptSource',
      'Debugger.evaluateOnCallFrame',
      'Debugger.removeBreakpoint',
      'Debugger.resume',
      'Debugger.disable',
    ]
  );
  assert.equal(
    result.trace.every((entry) => entry.sessionId === 'session'),
    true
  );
  assert.equal(input.state.disabled, true);
});

test('a stale live generation cannot count as installer admission', async () => {
  const result = await stage1ClientRow({ ...fixture({ stale: true }), row: install });
  assert.deepEqual(stage1RowFailures(install, result, rescue), ['liveReads']);
});

test('a protected-hop error-page event fails the scrub row', async () => {
  const row = {
    id: 'protected-error-page',
    mode: 'protected-hop',
    expected: { admitted: true, published: false, committed: false, released: true },
    requires: ['privateRescueAudit'],
  };
  for (const leak of [false, true]) {
    const result = await stage1ClientRow({ ...fixture({ leak, protectedReleased: true }), row });
    assert.deepEqual(stage1RowFailures(row, result, rescue), leak ? ['published'] : []);
  }
});

test('holder loss requires independent private rescue evidence and does not issue a client rescue', async () => {
  const row = { ...install, id: 'holder-death', mode: 'holder-death' };
  const result = await stage1ClientRow({ ...fixture({ audit: {} }), row });
  assert.deepEqual(
    stage1RowFailures(row, result, rescue),
    Object.keys(rescue).map((key) => `rescue.${key}`)
  );
  assert.equal(result.trace.filter((entry) => entry.method === 'Debugger.resume').length, 1);
  assert.equal(
    result.trace.some((entry) => entry.method === 'Debugger.disable'),
    false
  );
});

test('a transport or version error is not a free-pause refusal', async () => {
  await assert.rejects(
    stage1ClientRow({ ...fixture({ freeError: 'old version' }), row: install }),
    /no explicit free-pause refusal/
  );
});

test('a stalled client reply is a failed proof and never switches route', async () => {
  const input = fixture();
  input.client.send = () => new Promise(() => {});
  await assert.rejects(
    stage1ClientRow({ ...input, budget: 5, row: install }),
    /no explicit free-pause refusal/
  );
});
