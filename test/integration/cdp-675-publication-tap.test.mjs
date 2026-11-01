import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const packaged = await readFile(new URL('./cdp-675-packaged.test.mjs', import.meta.url), 'utf8');
const start = packaged.indexOf('function tapGuardSource(source) {');
const end = packaged.indexOf('\nasync function lateFrameRow', start);
const tap = new Function(`${packaged.slice(start, end)}; return tapGuardSource;`)();

test('publication tap preserves the proof outcome and captures the refusing predicate', async () => {
  const source = `class Guard {
  async debuggerEventReady(message, revision) {
    const { method, sessionId } = message;
    if (
      (await this.placed(sessionId)) &&
      this.revisions.get(this.scopeTarget(sessionId)) === revision &&
      !['suspended', 'revoked'].includes(this.debuggerLeases.get(this.scopeTarget(sessionId))?.state) &&
      !this.locked(sessionId) && !this.hidden(sessionId)
    ) return true;
    if (method === 'Debugger.paused') void this.call('Debugger.resume', {}, sessionId);
    return false;
  }
}
globalThis.Guard = Guard;`;
  const context = vm.createContext({ Date });
  vm.runInContext(tap(source), context);
  const guard = new context.Guard();
  guard.placed = async () => false;
  guard.scopeTarget = () => '12';
  guard.scope = () => ({ ready: false, pending: 1, failed: false });
  guard.revisions = new Map([['12', 8]]);
  guard.debuggerLeases = new Map();
  guard.locked = () => true;
  guard.hidden = () => false;
  const calls = [];
  guard.call = (...args) => calls.push(args);
  assert.equal(
    await guard.debuggerEventReady({ method: 'Debugger.paused', sessionId: 'holder' }, 7),
    false
  );
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['Debugger.resume', {}, 'holder']]);
  const record = context.cdp675PublicationTrace[0];
  assert.equal(record.placed, false);
  assert.equal(record.currentRevision, 8);
  assert.equal(record.capturedRevision, 7);
  assert.equal(record.locked, true);
  assert.equal(record.pending, 1);
  guard.placed = async () => true;
  guard.locked = () => false;
  assert.equal(
    await guard.debuggerEventReady({ method: 'Debugger.scriptParsed', sessionId: 'holder' }, 8),
    true
  );
  assert.equal(calls.length, 1);
});

test('world tap distinguishes creation, failed live proof, and loading without changing marks', () => {
  const source = `class Guard {
  created(sessionId, params) {
    const { id, auxData } = params.context;
    const hidden = false;
    const world = this.world(sessionId);
      world.ids.set(id, hidden);
  }
  refused(targetId, sessionId, context, answer) {
    const world = this.world(sessionId);
      world.ids.set(context.id, true);
  }
  loading(record, context, value) {
    const world = this.world(record.message.sessionId);
    world.ids.set(context.id, true);
  }
}
globalThis.Guard = Guard;`;
  const context = vm.createContext({ Date });
  vm.runInContext(tap(source), context);
  const guard = new context.Guard();
  const world = { ids: new Map() };
  guard.world = () => world;
  guard.scopeTarget = () => 'root';
  guard.errorFrames = new Set();
  const main = {
    id: 3,
    name: '',
    origin: 'https://ordinary.invalid',
    auxData: { frameId: 'root' },
  };
  guard.created('holder', { context: main });
  assert.equal(world.ids.get(3), false);
  guard.refused('root', 'holder', main, { error: { message: 'refused' } });
  assert.equal(world.ids.get(3), true);
  guard.loading({ targetId: 'root', message: { sessionId: 'holder' } }, { id: 4 }, 'about:blank');
  assert.equal(world.ids.get(4), true);
  const records = JSON.parse(JSON.stringify(context.cdp675WorldTrace));
  assert.deepEqual(
    records.map(({ phase }) => phase),
    ['context-created', 'context-proof-refused', 'loading-context']
  );
  assert.deepEqual(records[1].context, main);
  assert.equal(records[1].answer.error.message, 'refused');
  assert.equal(records[2].value, 'about:blank');
});

test('real guard tap parses and instruments each proof site exactly once', async () => {
  const source = await readFile(new URL('../../src/seed/guard.js', import.meta.url), 'utf8');
  const tapped = tap(source);
  new vm.Script(tapped.replace(/^import .*;$/gm, '').replace(/^export /gm, ''));
  for (const phase of ['context-created', 'context-proof-refused', 'loading-context'])
    assert.equal(tapped.split(`phase: '${phase}'`).length, 2);
  assert.equal(tapped.split('cdp675PublicationTrace ??=').length, 2);
});
