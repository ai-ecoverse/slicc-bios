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
} from './guard-ordering-fixture.mjs';

async function blocked(t, id = 'blank-wipe') {
  const wire = protocol(t);
  const entry = wire.target(id, 'page', plainFrame(id));
  const session = await wire.attach(id);
  await wire.send('Page.enable', {}, session);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: `guard-${id}`,
    params: {
      requestId: `${id}-blocked`,
      frameId: id,
      resourceType: 'Document',
      request: { url: failed },
    },
  });
  await flush();
  entry.tree.frame = { ...errorFrame(id), loaderId: `${id}-error-loader` };
  entry.info.url = entry.tree.frame.url;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${id}`,
    params: { frame: entry.tree.frame },
  });
  wire.emit({
    method: 'Page.frameStoppedLoading',
    sessionId: `guard-${id}`,
    params: { frameId: id },
  });
  await flush();
  return { wire, entry, session, id };
}

const wipes = (wire) =>
  wire.sent.filter(
    (message) => message.method === 'Page.navigate' && message.params.url === BLANKED
  );

async function advance(t, ms) {
  for (let left = ms; left > 0; left -= 100) {
    t.mock.timers.tick(Math.min(100, left));
    await flush();
  }
}

function wireCommit(state) {
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${state.id}`,
    params: { frame: state.entry.tree.frame },
  });
  state.wire.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { ...state.entry.info } },
  });
}

test('ordering a content read during a BLANKED wipe waits for the blank proof', async (t) => {
  const state = await blocked(t, 'blank-wipe-wait');
  await advance(t, 5000);
  assert.equal(wipes(state.wire).length, 1);
  const pending = state.wire.request('Runtime.evaluate', { expression: '1' }, state.session);
  await flush();
  state.entry.tree.frame = {
    ...plainFrame('blank-wipe-wait'),
    url: BLANKED,
    securityOrigin: 'null',
    loaderId: 'blank-loader',
  };
  state.entry.info.url = BLANKED;
  state.entry.info.title = 'blocked';
  wireCommit(state);
  await advance(t, 100);
  const answer = await pending.answer;
  assert.equal(answer.error, undefined);
  assert.equal(
    state.wire.clients().some((message) => message.method === 'Runtime.evaluate'),
    true
  );
  assert.equal(
    (await state.wire.send('Runtime.evaluate', { expression: '1' }, state.session)).error,
    undefined
  );
});

test('ordering a failed protected document stays refused while no wipe blank is in flight', async (t) => {
  const state = await blocked(t, 'blank-wipe-error');
  assert.equal(wipes(state.wire).length, 0);
  const mark = state.wire.sent.length;
  assert.equal(
    (await state.wire.send('Runtime.evaluate', { expression: '1' }, state.session)).error?.message,
    PROTECTED
  );
  assert.deepEqual(state.wire.clients(mark), []);
});

test('ordering a BLANKED wipe whose proof never arrives refuses after the wait', async (t) => {
  const state = await blocked(t, 'blank-wipe-timeout');
  await advance(t, 5000);
  assert.equal(wipes(state.wire).length, 1);
  const pending = state.wire.request('Runtime.evaluate', { expression: '1' }, state.session);
  await flush();
  await advance(t, 5000);
  assert.equal((await pending.answer).error?.message, PROTECTED);
  assert.equal(
    state.wire.clients().some((message) => message.method === 'Runtime.evaluate'),
    false
  );
});

test('ordering a mismatched blank commit after a wipe still refuses content', async (t) => {
  const state = await blocked(t, 'blank-wipe-mismatch');
  await advance(t, 5000);
  assert.equal(wipes(state.wire).length, 1);
  const pending = state.wire.request('Runtime.evaluate', { expression: '1' }, state.session);
  await flush();
  state.entry.tree.frame = {
    ...plainFrame('blank-wipe-mismatch'),
    url: ordinary,
    loaderId: 'ordinary-loader',
  };
  state.entry.info.url = ordinary;
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${state.id}`,
    params: { frame: state.entry.tree.frame },
  });
  await advance(t, 100);
  assert.equal((await pending.answer).error?.message, PROTECTED);
  assert.equal(
    state.wire.clients().some((message) => message.method === 'Runtime.evaluate'),
    false
  );
});

test('ordering an unreachable protected chrome-error document stays refused', async (t) => {
  const state = await blocked(t, 'blank-wipe-chrome-error');
  state.entry.tree.frame = {
    ...errorFrame('blank-wipe-chrome-error'),
    loaderId: 'still-error-loader',
    unreachableUrl: failed,
  };
  state.entry.info.url = state.entry.tree.frame.url;
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${state.id}`,
    params: { frame: state.entry.tree.frame },
  });
  await flush();
  const mark = state.wire.sent.length;
  assert.equal(
    (await state.wire.send('Runtime.evaluate', { expression: '1' }, state.session)).error?.message,
    PROTECTED
  );
  assert.deepEqual(state.wire.clients(mark), []);
});

test('ordering an owned blank root with a contained protected error child refuses content', async (t) => {
  const id = 'blank-wipe-child-error';
  const child = `${id}-child`;
  const wire = protocol(t);
  const entry = wire.target(id, 'page', plainFrame(id));
  const session = await wire.attach(id);
  await wire.send('Page.enable', {}, session);
  const blankFrame = { id, loaderId: 'blank-loader', url: BLANKED, securityOrigin: 'null' };
  entry.info.url = BLANKED;
  entry.info.title = 'blocked';
  entry.tree = { frame: blankFrame };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${id}`,
    params: { frame: blankFrame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
  await flush();
  await flush();
  wire.hold((message) => {
    if (message.method === 'Page.getFrameTree' && String(message.sessionId).startsWith('client-')) {
      queueMicrotask(() =>
        wire.release(message, { result: { frameTree: { frame: { ...blankFrame } } } })
      );
      return true;
    }
    return false;
  });
  const mark = wire.sent.length;
  const pending = wire.request('Runtime.evaluate', { expression: '1' }, session);
  const childFrame = {
    ...errorFrame(child, id),
    loaderId: 'child-error-loader',
  };
  entry.tree = { frame: blankFrame, childFrames: [{ frame: childFrame }] };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${id}`,
    params: { frame: childFrame },
  });
  assert.equal((await pending.answer).error?.message, PROTECTED);
  assert.equal(
    wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
    false
  );
});
