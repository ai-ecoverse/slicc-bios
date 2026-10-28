import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  guardProtected,
  ordinary,
  plainFrame,
  protocol,
} from './guard-state-fixture.mjs';

async function closingPage(t, id, observed = true, loader = 'close-error-loader') {
  let connection;
  let closed = 0;
  const wire = protocol(t, (raw, own) => {
    raw.close = () => {
      closed += 1;
    };
    connection = guardProtected(raw, own);
    return connection;
  });
  const entry = wire.target(id);
  await wire.attach(id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: `guard-${id}`,
    params: {
      requestId: 'close-protected',
      frameId: id,
      resourceType: 'Document',
      request: { url: failed },
    },
  });
  await flush();
  entry.tree.frame = { ...errorFrame(id), loaderId: loader };
  entry.info.url = failed;
  if (observed)
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: `guard-${id}`,
      params: { frame: entry.tree.frame },
    });
  await flush();
  return {
    wire,
    entry,
    connection,
    closed: () => closed,
    wipes: () => wire.sent.filter((m) => m.method === 'Page.navigate' && m.params.url === BLANKED),
  };
}

for (const change of [
  'ordinary page',
  'different root',
  'different loader',
  'parented proof',
  'different error URL',
  'ordinary error',
  'live protected child',
  'missing observed loader',
  'missing error commit',
  'pending protected load',
]) {
  test(`state client close never blanks a moved or unproved protected error document: ${change}`, async (t) => {
    const id = `close-proof-${change.replaceAll(' ', '-')}`;
    const state = await closingPage(
      t,
      id,
      change !== 'missing error commit',
      change === 'missing observed loader' ? '' : 'close-error-loader'
    );
    if (change === 'ordinary page')
      state.entry.tree.frame = { ...plainFrame(id), loaderId: 'ordinary-after-error' };
    if (change === 'different root')
      state.entry.tree.frame = { ...state.entry.tree.frame, id: 'unobserved-error-root' };
    if (change === 'different loader')
      state.entry.tree.frame = { ...state.entry.tree.frame, loaderId: 'unobserved-error-loader' };
    if (change === 'parented proof')
      state.entry.tree.frame = { ...state.entry.tree.frame, parentId: 'unknown-main-parent' };
    if (change === 'different error URL')
      state.entry.tree.frame = { ...state.entry.tree.frame, url: 'chrome-error://different/' };
    if (change === 'ordinary error')
      state.entry.tree.frame = { ...state.entry.tree.frame, unreachableUrl: ordinary };
    if (change === 'live protected child')
      state.entry.tree.childFrames = [
        {
          frame: {
            ...plainFrame('close-live-child', id),
            url: failed,
            securityOrigin: new URL(failed).origin,
          },
        },
      ];
    if (change === 'pending protected load')
      state.wire.emit({
        method: 'Page.frameStartedNavigating',
        sessionId: `guard-${id}`,
        params: {
          frameId: id,
          loaderId: 'new-protected-load',
          url: failed,
          navigationType: 'differentDocument',
        },
      });
    const mark = state.wire.delivered.length;
    state.connection.close();
    await flush();
    assert.equal(state.wipes().length, 0);
    assert.equal(state.closed(), 1);
    assert.equal(state.wire.delivered.length, mark);
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(state.wipes().length, 0);
    assert.equal(state.closed(), 1);
  });
}

test('state a close scrub has a hard deadline and a late proof cannot send a private blank', async (t) => {
  const id = 'close-proof-deadline';
  const state = await closingPage(t, id);
  state.wire.hold(
    (message) => message.method === 'Page.getFrameTree' && message.sessionId === `guard-${id}`
  );
  state.connection.close();
  await flush();
  const check = state.wire.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(check);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(state.closed(), 1);
  state.wire.release(check, { result: { frameTree: state.entry.tree } });
  await flush();
  assert.equal(state.wipes().length, 0);
  assert.equal(state.closed(), 1);
});
