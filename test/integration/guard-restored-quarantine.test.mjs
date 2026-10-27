import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED, PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  flush,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

const hint = (wire, entry, url = `${protectedOrigin}/private`) => {
  entry.info.url = url;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
};
const detached = (wire, session, mark = 0) =>
  wire.sent
    .slice(mark)
    .some(
      (message) =>
        message.method === 'Target.detachFromTarget' && message.params.sessionId === session
    );
const body = (sessionId) => ({
  method: 'DOM.childNodeInserted',
  sessionId,
  params: { parentNodeId: 1, node: { nodeId: 2, nodeValue: 'synthetic-pending-document' } },
});
const blank = (entry) => {
  entry.info.url = BLANKED;
  entry.tree.frame = { id: entry.info.targetId, url: BLANKED, securityOrigin: '://' };
  entry.history = { currentIndex: 0, entries: [{ id: 1, url: BLANKED }] };
};
function cleanup(t, wire) {
  t.after(() => {
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
  });
}

for (const kind of ['ordinary', 'error']) {
  test(`restored quarantine a positive ${kind} proof survives to the fresh blank screenshot`, async (t) => {
    const wire = protocol(t);
    cleanup(t, wire);
    const entry = wire.target(`keep-${kind}`);
    const session = await wire.attach(entry.info.targetId);
    if (kind === 'error') entry.tree.frame = errorFrame(entry.info.targetId);
    wire.hold((message) => message.method === 'Page.getFrameTree');
    const mark = wire.sent.length;
    hint(wire, entry);
    await flush();
    assert.equal(detached(wire, session, mark), false);
    assert.equal(wire.held.filter((message) => message.sessionId === session).length, 1);
    for (const method of [
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Page.getFrameTree',
      'Page.getNavigationHistory',
      'Input.dispatchKeyEvent',
    ]) {
      assert.equal((await wire.send(method, {}, session)).error?.message, PROTECTED);
    }
    const receipt = wire.delivered.length;
    wire.emit(body(session));
    wire.emit({
      method: 'Page.screencastFrame',
      sessionId: session,
      params: { data: 'c3ludGhldGlj', metadata: {}, sessionId: 1 },
    });
    wire.hold(() => false);
    wire.release(wire.held[0]);
    await flush();
    assert.equal(detached(wire, session, mark), false);
    assert.equal(
      wire.delivered
        .slice(receipt)
        .some((message) =>
          ['DOM.childNodeInserted', 'Page.screencastFrame'].includes(message.method)
        ),
      false
    );
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: 'document.title' }, session)).error
        ?.message,
      PROTECTED
    );
    blank(entry);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    await flush();
    const shot = await wire.send('Page.captureScreenshot', {}, session);
    assert.equal(shot.error, undefined);
    assert.equal(shot.result.data, 'c3ludGhldGlj');
  });
}

for (const method of ['Runtime.evaluate', 'Page.captureScreenshot']) {
  test(`restored quarantine an in-flight ${method} answer cannot revive after positive evidence`, async (t) => {
    const wire = protocol(t);
    cleanup(t, wire);
    const entry = wire.target('late-answer');
    const session = await wire.attach('late-answer');
    blank(entry);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    await flush();
    wire.hold((message) => message.method === method && message.id < 2 ** 30);
    const pending = wire.request(method, { expression: 'document.title' }, session);
    await flush();
    const answer = wire.held.find((message) => message.id === pending.id);
    assert.ok(answer);
    hint(wire, entry);
    await flush();
    assert.equal(detached(wire, session), false);
    wire.release(answer);
    assert.equal((await pending.answer).error?.message, PROTECTED);
    wire.hold(() => false);
    assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error, undefined);
  });
}

for (const payload of [
  { error: { code: -32000, message: 'tree failed' } },
  { result: {} },
  { result: { frameTree: { frame: {} } } },
  { result: { frameTree: { frame: { id: 'invalid', url: 'https://ordinary.invalid/' } } } },
  { result: { frameTree: { frame: { id: 'invalid', url: 'not a URL', securityOrigin: '://' } } } },
  { result: { frameTree: { frame: plainFrame('invalid'), childFrames: [{}] } } },
]) {
  test(`restored quarantine no positive document evidence cuts ${JSON.stringify(payload)}`, async (t) => {
    const wire = protocol(t);
    cleanup(t, wire);
    const entry = wire.target('invalid');
    const session = await wire.attach('invalid');
    wire.hold((message) => {
      if (message.method !== 'Page.getFrameTree') return false;
      queueMicrotask(() => wire.release(message, payload));
      return true;
    });
    const mark = wire.sent.length;
    hint(wire, entry);
    await flush();
    assert.equal(detached(wire, session, mark), true);
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  });
}

test('restored quarantine unanswered evidence cuts at the deadline without blocking other targets', async (t) => {
  const wire = protocol(t);
  cleanup(t, wire);
  const entry = wire.target('unanswered');
  const session = await wire.attach('unanswered');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.hold((message) => message.method === 'Page.getFrameTree');
  const mark = wire.sent.length;
  hint(wire, entry);
  await flush();
  const later = wire.target('progress');
  wire.emit({ method: 'Target.targetCreated', params: { targetInfo: later.info } });
  await flush();
  assert.equal(
    wire.delivered.some(
      (message) =>
        message.method === 'Target.targetCreated' &&
        message.params.targetInfo.targetId === 'progress'
    ),
    true
  );
  assert.equal(detached(wire, session, mark), false);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(detached(wire, session, mark), true);
  wire.release(wire.held[0]);
  await flush();
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
});

for (const stale of ['ordinary', 'protected']) {
  test(`restored quarantine a superseded ${stale} answer cannot decide the newer hint`, async (t) => {
    const wire = protocol(t);
    cleanup(t, wire);
    const entry = wire.target('superseded');
    const session = await wire.attach('superseded');
    wire.hold((message) => message.method === 'Page.getFrameTree');
    const mark = wire.sent.length;
    hint(wire, entry);
    await flush();
    const first = wire.held[0];
    hint(wire, entry);
    await flush();
    const second = wire.held.find((message) => message !== first);
    assert.ok(second);
    wire.release(first, {
      result: {
        frameTree: {
          frame:
            stale === 'ordinary'
              ? plainFrame('superseded')
              : { ...plainFrame('superseded'), securityOrigin: protectedOrigin },
        },
      },
    });
    await flush();
    assert.equal(detached(wire, session, mark), false);
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
    wire.hold(() => false);
    wire.release(second);
    await flush();
    assert.equal(detached(wire, session, mark), false);
    blank(entry);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    await flush();
    assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error, undefined);
  });
}

for (const method of ['Target.targetDestroyed', 'Target.detachedFromTarget']) {
  test(`restored quarantine ${method} cannot be undone by late evidence`, async (t) => {
    const wire = protocol(t);
    cleanup(t, wire);
    const entry = wire.target('gone');
    const session = await wire.attach('gone');
    wire.hold((message) => message.method === 'Page.getFrameTree');
    hint(wire, entry);
    await flush();
    wire.emit({ method, params: { targetId: 'gone', sessionId: session } });
    await flush();
    wire.release(wire.held[0]);
    await flush();
    wire.emit(body(session));
    await flush();
    assert.equal(
      wire.delivered.some((message) => message.method === 'DOM.childNodeInserted'),
      false
    );
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  });
}

test('restored quarantine receipt closes a session even while an unrelated root attach is pending', async (t) => {
  const wire = protocol(t);
  cleanup(t, wire);
  const entry = wire.target('receipt-owner');
  const session = await wire.attach('receipt-owner');
  wire.target('root-blocker');
  wire.hold(
    (message) =>
      message.method === 'Page.getFrameTree' && message.sessionId === 'client-root-blocker'
  );
  wire.attached('root-blocker');
  await flush();
  assert.equal(wire.held.length, 1);
  const receipt = wire.delivered.length;
  hint(wire, entry);
  wire.emit(body(session));
  assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error?.message, PROTECTED);
  await flush();
  assert.equal(
    wire.delivered.slice(receipt).some((message) => message.method === 'DOM.childNodeInserted'),
    false
  );
  wire.hold(() => false);
  wire.release(wire.held[0]);
  await flush();
  assert.equal(detached(wire, session), false);
  blank(entry);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: entry.tree.frame },
  });
  await flush();
  assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error, undefined);
});

for (const kind of ['frame', 'child']) {
  test(`restored quarantine a protected ${kind} cannot survive the document proof`, async (t) => {
    const wire = protocol(t);
    cleanup(t, wire);
    const entry = wire.target('proof-live');
    const session = await wire.attach('proof-live');
    wire.hold((message) => message.method === 'Page.getFrameTree');
    const mark = wire.sent.length;
    hint(wire, entry);
    await flush();
    const live = {
      ...plainFrame(kind === 'child' ? 'proof-child' : 'proof-live'),
      securityOrigin: protectedOrigin,
    };
    if (kind === 'child') entry.tree.childFrames = [{ frame: { ...live, parentId: 'proof-live' } }];
    else wire.emit({ method: 'Page.frameNavigated', sessionId: session, params: { frame: live } });
    wire.release(wire.held[0]);
    await flush();
    assert.equal(detached(wire, session, mark), true);
    assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  });
}

test('restored quarantine a fresh commit supersedes error evidence before it can taint the blank', async (t) => {
  const wire = protocol(t);
  cleanup(t, wire);
  const entry = wire.target('fresh-commit');
  const session = await wire.attach('fresh-commit');
  wire.hold((message) => message.method === 'Page.getFrameTree');
  hint(wire, entry);
  await flush();
  const first = wire.held[0];
  blank(entry);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: entry.tree.frame },
  });
  await flush();
  const second = wire.held.find((message) => message !== first);
  assert.ok(second);
  wire.release(first, { result: { frameTree: { frame: errorFrame('fresh-commit') } } });
  await flush();
  wire.hold(() => false);
  wire.release(second);
  await flush();
  assert.equal(detached(wire, session), false);
  assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error, undefined);
});
