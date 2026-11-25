import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected, PROTECTED, UNGUARDED } from '../../src/seed/guard.js';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const route = { kind: 'extension', version: '7.15.0' };
const PROBE_WAIT = 2000;

const dom = (ids) => ({
  nodeId: 1,
  nodeName: '#document',
  children: ids.map((frameId, index) => ({
    nodeName: 'IFRAME',
    frameId,
    backendNodeId: index + 2,
    attributes: ['src', 'http://nonexistent.invalid/'],
  })),
});

const snapshot = (ids, entry = { kind: 'error', errorProtected: false }, revision = 0) => ({
  version: 2,
  rootFrameId: 'root',
  rootLoaderId: 'root-loader',
  revision,
  localFrames: ['root'],
  remoteOwners: ids.map((frameId, index) => ({ frameId, backendNodeId: index + 2 })),
  frames: [
    { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
    ...ids.map((_, index) => ({
      frameId: index + 1,
      parentFrameId: 0,
      ...(typeof entry === 'string' ? { kind: entry } : entry),
    })),
  ],
});

async function settle() {
  for (let i = 0; i < 20; i += 1) await flush();
}

const bump = (p) =>
  p.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: p.targets.get('root').info },
  });

function fixture(t, reader) {
  const p = protocol(t, (raw, own) => guardProtected(raw, own, new Map(), route, reader));
  const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'root-loader' });
  root.dom = dom([]);
  return { p, root };
}

async function openLate(t, entry) {
  let resolve;
  let hold = false;
  let reads = 0;
  let list = snapshot([]);
  const { p, root } = fixture(t, async () => {
    reads += 1;
    if (hold)
      return new Promise((done) => {
        resolve = done;
      });
    return structuredClone(list);
  });
  const session = await p.attach('root');
  await settle();
  assert.equal((await p.send('DOM.getDocument', { depth: 1 }, session)).error, undefined);
  const placedReads = reads;
  list = entry;
  hold = true;
  root.dom = dom(['remote']);
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'remote', parentFrameId: 'root' },
  });
  await settle();
  assert.ok(reads > placedReads, 'late owner must start a frames() placement');
  assert.ok(resolve, 'frames() must be waiting on the late placement');
  return {
    p,
    session,
    reads: () => reads,
    release: (value = list) => {
      hold = false;
      resolve?.(structuredClone(value));
    },
  };
}

test('a page read that arrives while frames() is open waits for the revision retry and gets #document', async (t) => {
  const { p, session, reads, release } = await openLate(
    t,
    snapshot(['remote'], { kind: 'error', errorProtected: false }, 1)
  );
  const pending = p.request('DOM.getDocument', { depth: 1 }, session);
  await settle();
  assert.equal(
    p.delivered.some(({ id }) => id === pending.id),
    false,
    'the page read must not answer while placement is open'
  );
  bump(p);
  release();
  await settle();
  const answer = await pending.answer;
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.equal(answer.result?.root?.nodeName, '#document');
  assert.ok(reads() >= 2, 'frames() must run again after the revision moved');
});

test('when frames() settles just before the page read, the read gets #document after the revision retry', async (t) => {
  const { p, session, reads, release } = await openLate(
    t,
    snapshot(['remote'], { kind: 'error', errorProtected: false }, 1)
  );
  bump(p);
  release();
  await settle();
  const answer = await p.send('DOM.getDocument', { depth: 1 }, session);
  assert.equal(answer.error, undefined, JSON.stringify(answer));
  assert.equal(answer.result?.root?.nodeName, '#document');
  assert.ok(reads() >= 2, 'frames() must run again after the revision moved');
});

test('the same revision race with a protected iframe still refuses the page read', async (t) => {
  const { p, session, release } = await openLate(t, snapshot(['remote'], 'protected', 1));
  const pending = p.request('DOM.getDocument', { depth: 1 }, session);
  await settle();
  assert.equal(
    p.delivered.some(({ id }) => id === pending.id),
    false,
    'must not forward while the protected placement is open'
  );
  bump(p);
  release();
  await settle();
  assert.equal((await pending.answer).error?.message, PROTECTED);
});

test('the same revision race with an unproven iframe still refuses the page read', async (t) => {
  const { p, session, release } = await openLate(t, snapshot(['remote'], 'unknown', 1));
  const pending = p.request('DOM.getDocument', { depth: 1 }, session);
  await settle();
  assert.equal(
    p.delivered.some(({ id }) => id === pending.id),
    false,
    'must not forward while the unproven placement is open'
  );
  bump(p);
  release();
  await settle();
  assert.equal((await pending.answer).error?.message, PROTECTED);
});

test('when every frames() answers after the PROBE_WAIT envelope the page read is refused inside the bound', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let hold = false;
  let reads = 0;
  let list = snapshot([]);
  const { p, root } = fixture(t, async () => {
    reads += 1;
    const body = structuredClone(list);
    if (!hold) return body;
    return new Promise((done) => {
      setTimeout(() => done(body), PROBE_WAIT + 1);
    });
  });
  const session = await p.attach('root');
  await settle();
  const placedReads = reads;
  hold = true;
  list = snapshot(['remote'], { kind: 'error', errorProtected: false }, 1);
  root.dom = dom(['remote']);
  p.emit({
    sessionId: session,
    method: 'Page.frameAttached',
    params: { frameId: 'remote', parentFrameId: 'root' },
  });
  await settle();
  assert.ok(reads > placedReads, 'late owner must open a frames() placement');
  const started = Date.now();
  const pending = p.request('DOM.getDocument', { depth: 1 }, session);
  await settle();
  assert.equal(
    p.delivered.some(({ id }) => id === pending.id),
    false,
    'must not forward while placement is open'
  );
  t.mock.timers.tick(PROBE_WAIT);
  await settle();
  const answer = await pending.answer;
  const elapsed = Date.now() - started;
  assert.equal(answer.result?.root?.nodeName, undefined, 'must never forward #document');
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.ok(
    answer.error?.message === PROTECTED || answer.error?.message === UNGUARDED,
    `refused as today, got ${answer.error?.message}`
  );
  assert.ok(
    elapsed <= PROBE_WAIT,
    `placement must give up within one PROBE_WAIT envelope (2 s), elapsed ${elapsed} ms`
  );
  assert.ok(
    reads - placedReads <= 3,
    `at most three placeOne attempts inside the envelope, got ${reads - placedReads}`
  );
});
