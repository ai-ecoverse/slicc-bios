import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { tapDebuggerSource } from './cdp-675-native-tap.mjs';

const source = `class DebuggerGate {
  constructor(connection) { this.connection = connection; this.states = new Map(); }
  async event() { return this.answer; }
  async proof() { if (this.error) throw this.error; return this.answer; }
  async pauseReady() { return false; }
  async paused() { return this.answer; }
  async convert() { return this.answer; }
  async resume() { return this.answer; }
  async drop() { return this.answer; }
  script() { return this.answer; }
  suspend() { return this.answer; }
  revoke() { return this.answer; }
  convertible() { return false; }
  childrenPlaced() { return this.answer; }
  knownChildren() { return this.answer; }
  context() { return this.answer; }
  ids() { if (this.error) throw this.error; return this.answer; }
  privateInstrumentation() { return true; }
  rememberPublished(state, pause) { pause.published = true; return this.answer; }
  lift(tabId, state) {
          state.suspension = null;
  }
}
globalThis.DebuggerGate = DebuggerGate;`;

function fixture() {
  const context = vm.createContext({ Date });
  vm.runInContext(tapDebuggerSource(source), context);
  const tab = {
    mainFrameId: 'root',
    documents: { frames: new Map([['root', { loaderId: 'loader' }]]) },
    frames: new Map([['child', true]]),
    worlds: { ids: new Map([[3, { hidden: true, context: { id: 3 } }]]) },
    debuggerFrameBlocks: new Set(),
  };
  const connection = { tabState: () => tab, state: { tabs: new Map([[12, tab]]) } };
  const gate = new context.DebuggerGate(connection);
  const state = {
    owner: 'owned',
    generation: 'loader',
    enabled: true,
    suspension: { deadline: 123 },
    scripts: new Map(),
    scriptInfo: new Map(),
    pause: { deadline: 456, published: false, converted: true },
  };
  gate.states.set(12, state);
  gate.answer = { unchanged: true };
  return { context, gate, state, tab };
}

test('gate tap preserves async results, refusals, and records native events before decisions', async () => {
  const { context, gate, state } = fixture();
  for (let id = 0; id < 20; id += 1) {
    state.scripts.set(String(id), {});
    state.scriptInfo.set(String(id), { context: 3 });
  }
  for (const name of ['paused', 'convert', 'resume', 'drop'])
    assert.equal(await gate[name](12, state), gate.answer);
  assert.equal(await gate.event(12, 'Debugger.paused', { reason: 'instrumentation' }), gate.answer);
  assert.equal(await gate.pauseReady(12, state, { reason: 'other' }), false);
  gate.error = new Error('same proof refusal');
  await assert.rejects(gate.proof(12, state), (error) => error === gate.error);
  const records = JSON.parse(JSON.stringify(context.cdp675NativeTrace));
  assert.ok(
    records.some(
      (record) =>
        record.phase === 'event' &&
        record.method === 'Debugger.paused' &&
        record.params.reason === 'instrumentation'
    )
  );
  assert.ok(
    records.some(
      (record) => record.phase === 'pauseReady' && record.verdict === false && record.suspended
    )
  );
  assert.ok(
    records.some(
      (record) =>
        record.phase === 'proof' &&
        record.outcome === 'error' &&
        record.reason === 'same proof refusal'
    )
  );
  assert.deepEqual(records[0].hidden, [3]);
  assert.equal(records[0].scriptCount, 20);
  assert.equal(records[0].scripts.length, 8);
  assert.equal(records[0].scriptInfoCount, 20);
  assert.equal(records[0].scriptInfo.length, 8);
});

test('gate tap preserves synchronous decisions and records lift and actual publication separately', () => {
  const { context, gate, state, tab } = fixture();
  for (const name of ['script', 'suspend', 'revoke', 'childrenPlaced', 'context'])
    assert.equal(gate[name](12, state), gate.answer);
  assert.equal(gate.knownChildren(tab), gate.answer);
  assert.equal(gate.convertible(12, state), false);
  assert.equal(gate.privateInstrumentation(12, state), true);
  assert.equal(gate.rememberPublished(state, state.pause), gate.answer);
  assert.equal(state.pause.published, true);
  gate.lift(12, state);
  assert.equal(state.suspension, null);
  gate.error = new Error('same predicate refusal');
  assert.throws(
    () => gate.ids(12, state),
    (error) => error === gate.error
  );
  const records = JSON.parse(JSON.stringify(context.cdp675NativeTrace));
  assert.ok(
    records.some(
      (record) => record.phase === 'publish' && record.tabId === 12 && record.pause.published
    )
  );
  assert.ok(
    records.some(
      (record) => record.phase === 'lift' && record.reason.includes('fresh whole-page proof')
    )
  );
  assert.ok(
    records.some((record) => record.phase === 'ids' && record.reason === 'same predicate refusal')
  );
  context.cdp675NativeTrace = Array.from({ length: 20000 }, () => null);
  gate.suspend(12, state);
  assert.equal(context.cdp675NativeTrace.length, 20000);
  assert.throws(() => tapDebuggerSource(''), assert.AssertionError);
});
