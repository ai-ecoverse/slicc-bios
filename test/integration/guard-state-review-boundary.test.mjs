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
} from './guard-state-fixture.mjs';

const wipes = (wire) =>
  wire.sent.filter(
    (message) => message.method === 'Page.navigate' && message.params.url === BLANKED
  );

async function blocked(t) {
  const wire = protocol(t);
  const entry = wire.target('review-owner');
  const session = await wire.attach('review-owner');
  await wire.send('Page.enable', {}, session);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: 'guard-review-owner',
    params: {
      requestId: 'first-request',
      frameId: 'review-owner',
      resourceType: 'Document',
      request: { url: failed },
    },
  });
  await flush();
  entry.tree.frame = { ...errorFrame('review-owner'), loaderId: 'first-error' };
  entry.info.url = failed;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-review-owner',
    params: { frame: entry.tree.frame },
  });
  await flush();
  return { wire, entry, session };
}

test('a new protected error document replaces the old scrub without losing the deferred blank', async (t) => {
  const { wire, entry, session } = await blocked(t);
  t.mock.timers.tick(2000);
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: 'guard-review-owner',
    params: {
      requestId: 'second-request',
      frameId: 'review-owner',
      resourceType: 'Document',
      request: { url: `${failed}?second` },
    },
  });
  await flush();
  entry.tree.frame = {
    ...errorFrame('review-owner'),
    loaderId: 'second-error',
    unreachableUrl: `${failed}?second`,
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-review-owner',
    params: { frame: entry.tree.frame },
  });
  await flush();
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(wipes(wire).length, 1);
});

test('a replaced protected error cancels the older in-flight expiry and still blanks its own document', async (t) => {
  const { wire, entry } = await blocked(t);
  wire.hold(
    (message) =>
      message.method === 'Page.getFrameTree' && message.sessionId === 'guard-review-owner'
  );
  t.mock.timers.tick(5000);
  await flush();
  const oldExpiry = wire.held[0];
  assert.ok(oldExpiry);
  wire.hold(() => false);
  entry.tree.frame = { ...errorFrame('review-owner'), loaderId: 'new-error' };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-review-owner',
    params: { frame: entry.tree.frame },
  });
  await flush();
  wire.release(oldExpiry, {
    result: { frameTree: { frame: { ...errorFrame('review-owner'), loaderId: 'first-error' } } },
  });
  await flush();
  assert.equal(wipes(wire).length, 0);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(wipes(wire).length, 1);
});

for (const typed of [false, true]) {
  test(`sealed error history never publishes a protected title ${typed}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('history-title');
    const session = await wire.attach('history-title');
    wire.hold((message) => {
      if (
        !['DOM.getDocument', 'DOM.disable'].includes(message.method) ||
        message.sessionId !== 'guard-history-title'
      )
        return false;
      queueMicrotask(() => wire.release(message, { error: { code: -32000, message: PROTECTED } }));
      return true;
    });
    const privateURL = `${failed}?history-query=private#history-fragment`;
    entry.tree.frame = errorFrame('history-title');
    entry.info.url = failed;
    entry.history = {
      currentIndex: 0,
      entries: [
        {
          id: 1,
          url: 'chrome-error://chromewebdata/',
          title: `Failed: ${privateURL}`,
          ...(typed ? { userTypedURL: privateURL } : {}),
        },
      ],
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-history-title',
      params: { frame: entry.tree.frame },
    });
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
    await flush();
    const answer = await wire.send('Page.getNavigationHistory', {}, session);
    assert.equal(answer.error, undefined);
    const text = JSON.stringify(answer.result);
    for (const marker of [new URL(failed).pathname, 'history-query', 'history-fragment'])
      assert.equal(text.includes(marker), false);
  });
}

async function pending(t) {
  const wire = protocol(t);
  const entry = wire.target('pending-review');
  const session = await wire.attach('pending-review');
  const start = () =>
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: 'guard-pending-review',
      params: {
        frameId: 'pending-review',
        loaderId: 'pending-protected',
        url: failed,
        navigationType: 'differentDocument',
      },
    });
  return { wire, entry, session, start };
}

for (const method of [
  'Page.getFrameTree',
  'Page.getResourceTree',
  'Page.getNavigationHistory',
  'Target.getTargetInfo',
  'Target.attachToTarget',
]) {
  test(`pending protected main load refuses recovery metadata ${method}`, async (t) => {
    const { wire, session, start } = await pending(t);
    start();
    await flush();
    const browser = method.startsWith('Target.');
    const mark = wire.sent.length;
    const answer = await wire.send(
      method,
      browser ? { targetId: 'pending-review', flatten: true } : {},
      browser ? undefined : session
    );
    assert.equal(answer.error?.message, PROTECTED);
    assert.deepEqual(wire.clients(mark), []);
  });
}

test('pending protected main load cannot publish an earlier history answer after ordinary recovery', async (t) => {
  const { wire, entry, session, start } = await pending(t);
  t.after(() => {
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
  });
  wire.hold((message) => message.method === 'Page.getNavigationHistory' && message.id < 2 ** 30);
  const attempt = wire.request('Page.getNavigationHistory', {}, session);
  await flush();
  const history = wire.held[0];
  assert.ok(history);
  start();
  entry.tree.frame = { ...plainFrame('pending-review'), loaderId: 'pending-protected' };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-pending-review',
    params: { frame: entry.tree.frame },
  });
  wire.release(history);
  assert.equal((await attempt.answer).error?.message, PROTECTED);
});

test('pending protected main load refuses an attach answer and auto-attach on the same tab', async (t) => {
  const { wire, session, start } = await pending(t);
  t.after(() => {
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
  });
  wire.hold((message) => message.method === 'Target.attachToTarget' && message.id < 2 ** 30);
  const attempt = wire.request('Target.attachToTarget', {
    targetId: 'pending-review',
    flatten: true,
  });
  await flush();
  const attachment = wire.held[0];
  assert.ok(attachment);
  start();
  wire.release(attachment);
  assert.equal((await attempt.answer).error?.message, PROTECTED);
  const mark = wire.delivered.length;
  wire.attached('pending-review');
  await flush();
  assert.equal(
    wire.delivered.slice(mark).some((message) => message.method === 'Target.attachedToTarget'),
    false
  );
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
});

test('pending protected main load still permits safe exits from its ordinary committed page', async (t) => {
  const { wire, session, start } = await pending(t);
  start();
  await flush();
  for (const method of ['Page.navigate', 'Page.reload', 'Page.stopLoading'])
    assert.equal(
      (await wire.send(method, method === 'Page.navigate' ? { url: ordinary } : {}, session)).error,
      undefined
    );
  assert.equal(
    (await wire.send('Target.closeTarget', { targetId: 'pending-review' })).error,
    undefined
  );
  assert.equal(
    (await wire.send('Runtime.evaluate', {}, session)).result?.result.value,
    'synthetic-content'
  );
});
