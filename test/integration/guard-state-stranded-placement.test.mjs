import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

async function owner(t) {
  const wire = protocol(t);
  const entry = wire.target('placed-recovery');
  const session = await wire.attach('placed-recovery');
  return { wire, entry, session };
}

async function error(state) {
  state.entry.tree.frame = errorFrame('placed-recovery');
  state.entry.info.url = failed;
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-placed-recovery',
    params: { frame: state.entry.tree.frame },
  });
  state.wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: state.entry.info } });
  await flush();
}

test('stranded proof retains the whole-page lock when a DOM owner is absent from the frame tree', async (t) => {
  const state = await owner(t);
  state.wire.hold((message) => {
    if (message.method !== 'DOM.getDocument' || message.sessionId !== 'guard-placed-recovery')
      return false;
    queueMicrotask(() =>
      state.wire.release(message, {
        result: {
          root: {
            nodeId: 1,
            nodeName: '#document',
            children: [
              {
                nodeId: 2,
                nodeName: 'IFRAME',
                frameId: 'unresolved-owner',
                attributes: ['src', ordinary],
              },
            ],
          },
        },
      })
    );
    return true;
  });
  await error(state);
  const sent = state.wire.sent.length;
  assert.equal((await state.wire.send('Page.reload', {}, state.session)).error?.message, PROTECTED);
  assert.equal(
    (await state.wire.send('Target.attachToTarget', { targetId: 'placed-recovery', flatten: true }))
      .error?.message,
    PROTECTED
  );
  assert.deepEqual(state.wire.clients(sent), []);
});

test('stranded proof cannot omit a separately placed protected child', async (t) => {
  const state = await owner(t);
  const child = state.wire.target(
    'placed-child',
    'iframe',
    plainFrame('placed-child', 'placed-recovery')
  );
  state.wire.attached('placed-child', 'guard-placed-recovery');
  await flush();
  child.tree.frame = { ...child.tree.frame, securityOrigin: protectedOrigin };
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'client-placed-child',
    params: { frame: child.tree.frame },
  });
  await error(state);
  assert.equal(
    (await state.wire.send('Target.getTargetInfo', { targetId: 'placed-recovery' })).error?.message,
    PROTECTED
  );
  assert.equal(
    (await state.wire.send('Page.stopLoading', {}, state.session)).error?.message,
    PROTECTED
  );
});

test('stranded scope keeps a protected committed document sticky through its later error page', async (t) => {
  const state = await owner(t);
  state.entry.tree.frame = {
    ...plainFrame('placed-recovery'),
    url: failed,
    securityOrigin: protectedOrigin,
  };
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-placed-recovery',
    params: { frame: state.entry.tree.frame },
  });
  await error(state);
  assert.equal(
    (await state.wire.send('Target.closeTarget', { targetId: 'placed-recovery' })).error?.message,
    PROTECTED
  );
  assert.equal((await state.wire.send('Target.getTargets')).result.targetInfos.length, 0);
  state.entry.tree.frame = plainFrame('placed-recovery');
  state.entry.info.url = ordinary;
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-placed-recovery',
    params: { frame: state.entry.tree.frame },
  });
  state.wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: state.entry.info } });
  await flush();
  assert.equal(
    (await state.wire.send('Target.getTargetInfo', { targetId: 'placed-recovery' })).error,
    undefined
  );
});

test('stranded ordinary evidence corrects a target-only protected hint without opening reads', async (t) => {
  const state = await owner(t);
  state.entry.info.url = failed;
  state.wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: state.entry.info } });
  await flush();
  const answer = await state.wire.send('Target.getTargetInfo', { targetId: 'placed-recovery' });
  assert.equal(answer.result.targetInfo.url, protectedOrigin);
  assert.equal(answer.result.targetInfo.title, protectedOrigin);
  assert.equal(
    (await state.wire.send('Page.navigate', { url: ordinary }, state.session)).error,
    undefined
  );
  assert.equal(
    (await state.wire.send('Runtime.evaluate', {}, state.session)).error?.message,
    PROTECTED
  );
});

test('stranded a superseded protected proof cannot relock an ordinary committed document', async (t) => {
  const state = await owner(t);
  await error(state);
  let captured = false;
  state.wire.hold((message) => {
    if (
      captured ||
      message.method !== 'Page.getFrameTree' ||
      message.sessionId !== 'guard-placed-recovery'
    )
      return false;
    captured = true;
    return true;
  });
  const attempt = state.wire.request('Target.activateTarget', { targetId: 'placed-recovery' });
  await flush();
  const proof = state.wire.held[0];
  assert.ok(proof);
  state.entry.tree.frame = plainFrame('placed-recovery');
  state.entry.info.url = ordinary;
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-placed-recovery',
    params: { frame: state.entry.tree.frame },
  });
  state.wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: state.entry.info } });
  await flush();
  state.wire.release(proof, {
    result: {
      frameTree: {
        frame: { ...plainFrame('placed-recovery'), url: failed, securityOrigin: protectedOrigin },
      },
    },
  });
  assert.equal((await attempt.answer).error?.message, PROTECTED);
  state.entry.info.url = failed;
  state.wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: state.entry.info } });
  await flush();
  const recovered = await state.wire.send('Target.getTargetInfo', { targetId: 'placed-recovery' });
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.result.targetInfo.url, protectedOrigin);
});
