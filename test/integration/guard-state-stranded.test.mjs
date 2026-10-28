import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, INHERITED, PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

async function stranded(t, type = 'page') {
  const wire = protocol(t);
  const entry = wire.target('stranded', type);
  const session = await wire.attach('stranded');
  entry.tree.frame = errorFrame('stranded');
  entry.info.url = `${failed}?private=query#fragment`;
  entry.info.title = 'private error title';
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-stranded',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  return { wire, entry, session };
}

function commit(wire, entry, frame) {
  entry.tree.frame = frame;
  entry.info.url = frame.url;
  wire.emit({ method: 'Page.frameNavigated', sessionId: 'guard-stranded', params: { frame } });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
}

const browserExits = [
  'Target.getTargetInfo',
  'Target.attachToTarget',
  'Target.activateTarget',
  'Target.closeTarget',
];
const sessionExits = [
  'Page.navigate',
  'Page.reload',
  'Page.stopLoading',
  'Page.enable',
  'Page.disable',
  'Page.getNavigationHistory',
];

for (const method of [...browserExits, ...sessionExits]) {
  test(`stranded error document admits only the exit ${method} with a fresh private proof`, async (t) => {
    const { wire, session, entry } = await stranded(t);
    entry.history = {
      currentIndex: 1,
      entries: [
        { id: 1, url: ordinary, title: 'ordinary' },
        { id: 2, url: failed, userTypedURL: failed, title: 'private history title' },
      ],
    };
    const mark = wire.sent.length;
    const answer = await wire.send(
      method,
      browserExits.includes(method) ? { targetId: 'stranded', flatten: true } : { url: ordinary },
      browserExits.includes(method) ? undefined : session
    );
    assert.equal(answer.error, undefined);
    assert.ok(
      wire.sent
        .slice(mark)
        .some(
          (message) =>
            message.method === 'Page.getFrameTree' && message.sessionId === 'guard-stranded'
        ),
      'every exit uses the guard navigation session, not a client tree'
    );
    if (method === 'Target.getTargetInfo') {
      assert.equal(answer.result.targetInfo.url, protectedOrigin);
      assert.equal(answer.result.targetInfo.title, protectedOrigin);
    }
    if (method === 'Target.attachToTarget') assert.ok(answer.result.sessionId);
    if (method === 'Page.getNavigationHistory') {
      assert.equal(answer.result.entries[0].url, ordinary);
      assert.equal(answer.result.entries[1].url, 'chrome-error://chromewebdata/');
      assert.equal(answer.result.entries[1].title, '');
    }
  });
}

test('stranded listings and target events expose only the protected origin', async (t) => {
  const { wire } = await stranded(t);
  const listed = await wire.send('Target.getTargets');
  assert.equal(listed.result.targetInfos.length, 1);
  assert.equal(listed.result.targetInfos[0].url, protectedOrigin);
  assert.equal(listed.result.targetInfos[0].title, protectedOrigin);
  const event = wire.delivered.find((message) => message.method === 'Target.targetInfoChanged');
  assert.ok(event);
  assert.equal(event.params.targetInfo.url, protectedOrigin);
  assert.equal(event.params.targetInfo.title, protectedOrigin);
  for (const marker of [
    new URL(failed).pathname,
    'private=query',
    '#fragment',
    'private error title',
  ])
    assert.equal(JSON.stringify([listed, event]).includes(marker), false);
});

test('stranded recovery clears the reported-URL latch but never admits inherited navigation', async (t) => {
  const { wire, entry, session } = await stranded(t);
  assert.equal(
    (await wire.send('Page.navigate', { url: 'about:blank' }, session)).error?.message,
    INHERITED
  );
  assert.equal((await wire.send('Page.navigate', { url: ordinary }, session)).error, undefined);
  commit(wire, entry, plainFrame('stranded'));
  await flush();
  assert.equal(
    (await wire.send('Runtime.evaluate', {}, session)).result.result.value,
    'synthetic-content'
  );
  assert.equal(
    (await wire.send('Target.getTargetInfo', { targetId: 'stranded' })).result.targetInfo.url,
    ordinary
  );
});

for (const method of [
  'Runtime.evaluate',
  'DOM.getDocument',
  'Page.captureScreenshot',
  'Page.getFrameTree',
  'Input.dispatchKeyEvent',
  'Network.enable',
]) {
  test(`stranded non-exit ${method} remains sealed`, async (t) => {
    const { wire, session } = await stranded(t);
    assert.equal((await wire.send(method, {}, session)).error?.message, PROTECTED);
  });
}

for (const state of [
  'protected child',
  'committed then removed',
  'ordinary root',
  'pending',
  'iframe',
]) {
  test(`stranded proof fails closed or unlocks only at an ordinary main commit: ${state}`, async (t) => {
    const { wire, entry, session } = await stranded(t, state === 'iframe' ? 'iframe' : 'page');
    if (
      state === 'protected child' ||
      state === 'committed then removed' ||
      state === 'ordinary root'
    ) {
      const child = { ...plainFrame('private-child', 'stranded'), securityOrigin: protectedOrigin };
      entry.tree.childFrames = [{ frame: child }];
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-stranded',
        params: { frame: child },
      });
      await flush();
      if (state !== 'protected child') {
        delete entry.tree.childFrames;
        wire.emit({
          method: 'Page.frameDetached',
          sessionId: 'guard-stranded',
          params: { frameId: child.id, reason: 'remove' },
        });
      }
      if (state === 'ordinary root') {
        commit(wire, entry, plainFrame('stranded'));
        await flush();
      }
    }
    if (state === 'pending') {
      wire.emit({
        method: 'Page.frameStartedNavigating',
        sessionId: 'guard-stranded',
        params: { frameId: 'stranded', url: failed, navigationType: 'restore' },
      });
      await flush();
    }
    const answer = await wire.send('Target.getTargetInfo', { targetId: 'stranded' });
    assert.equal(answer.error?.message, state === 'ordinary root' ? undefined : PROTECTED);
    if (state !== 'ordinary root')
      assert.equal((await wire.send('Page.reload', {}, session)).error?.message, PROTECTED);
  });
}

for (const payload of [
  { error: { code: -32000, message: 'no tree' } },
  { result: {} },
  { result: { frameTree: { frame: plainFrame('stranded'), childFrames: [{}] } } },
  { result: { frameTree: { frame: { ...plainFrame('stranded'), parentId: 'elsewhere' } } } },
]) {
  test(`stranded exit refuses invalid private evidence ${JSON.stringify(payload)}`, async (t) => {
    const { wire, session } = await stranded(t);
    wire.hold((message) => {
      if (message.method !== 'Page.getFrameTree' || message.sessionId !== 'guard-stranded')
        return false;
      queueMicrotask(() => wire.release(message, payload));
      return true;
    });
    assert.equal((await wire.send('Page.reload', {}, session)).error?.message, PROTECTED);
  });
}

test('stranded proof cannot clear the latch when a protected load starts during its answer', async (t) => {
  const { wire, entry, session } = await stranded(t);
  wire.hold(
    (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-stranded'
  );
  const exit = wire.request('Page.reload', {}, session);
  await flush();
  const proof = wire.held.find((message) => message.sessionId === 'guard-stranded');
  assert.ok(proof);
  wire.emit({
    method: 'Page.frameStartedNavigating',
    sessionId: 'guard-stranded',
    params: { frameId: 'stranded', url: failed, navigationType: 'restore' },
  });
  wire.release(proof);
  assert.equal((await exit.answer).error?.message, PROTECTED);
  wire.hold(() => false);
  commit(wire, entry, { ...plainFrame('stranded'), url: BLANKED, securityOrigin: 'null' });
  await flush();
});
