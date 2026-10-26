import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
const privateTrees = (wire, mark) =>
  wire.sent
    .slice(mark)
    .filter((message) => message.id >= 2 ** 30 && message.method === 'Page.getFrameTree');

for (const evidence of ['ordinary-attachment', 'placed-frame']) {
  test(`ordering ordinary admission needs only its own tree ${evidence}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('ordinary');
    const session = await wire.attach('ordinary');
    await read(wire, session);
    if (evidence === 'ordinary-attachment') {
      wire.sessions.set('second-client', 'ordinary');
      wire.emit({
        method: 'Target.attachedToTarget',
        params: { sessionId: 'second-client', targetInfo: entry.info, waitingForDebugger: false },
      });
    } else {
      const child = plainFrame('placed-child', 'ordinary');
      entry.tree.childFrames = [{ frame: child }];
      wire.emit({
        method: 'Page.frameAttached',
        sessionId: 'guard-ordinary',
        params: { frameId: child.id, parentFrameId: 'ordinary' },
      });
    }
    await flush();
    assert.equal((await read(wire, session)).error, undefined);
    const mark = wire.sent.length;
    assert.equal((await read(wire, session)).error, undefined);
    assert.deepEqual(
      privateTrees(wire, mark),
      [],
      'positive ordinary targets do not require a nonexistent guard commit'
    );
  });
}

test('ordering related owner recovers on a fresh guarded iframe commit and both positive trees', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const parent = wire.target('owner');
  const session = await wire.attach('owner');
  await read(wire, session);
  const frame = { ...plainFrame('child', 'owner'), loaderId: 'synthetic-child-loader' };
  parent.tree.childFrames = [{ frame }];
  const child = wire.target('child', 'iframe', frame, 'owner');
  const attached = wire.attached('child', session);
  await flush();
  await flush();
  assert.equal((await read(wire, session)).error, undefined);
  child.tree = { frame: errorFrame('child', 'owner') };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: attached,
    params: { frame: child.tree.frame },
  });
  assert.match((await read(wire, session)).error?.message ?? '', /^slicc: refused:/);
  child.tree = { frame };
  parent.tree.childFrames = [{ frame }];
  wire.emit({ method: 'Page.frameNavigated', sessionId: 'guard-child', params: { frame } });
  wire.emit({ method: 'Page.frameNavigated', sessionId: attached, params: { frame } });
  assert.equal((await read(wire, session)).error, undefined);
  const mark = wire.sent.length;
  assert.equal((await read(wire, session)).error, undefined);
  assert.deepEqual(
    privateTrees(wire, mark),
    [],
    'an owner needs no unrelated top-level commit after its iframe independently recovers'
  );
});

test('ordering a fresh guard commit survives a later harmless client notice without reviving old replies', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const frame = { ...plainFrame('ordinary'), loaderId: 'synthetic-current-loader' };
  wire.target('ordinary', 'page', frame);
  const session = await wire.attach('ordinary');
  await read(wire, session);
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
  const snapshot = wire.request('Page.captureScreenshot', {}, session);
  await flush();
  const pending = wire.held.find((message) => message.id === snapshot.id);
  assert.ok(pending);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: errorFrame('ordinary') },
  });
  wire.emit({ method: 'Page.frameNavigated', sessionId: 'guard-ordinary', params: { frame } });
  wire.emit({ method: 'Page.frameNavigated', sessionId: session, params: { frame } });
  wire.release(pending);
  const late = await snapshot.answer;
  assert.match(late.error?.message ?? '', /^slicc: refused:/);
  assert.equal(late.result, undefined);
  assert.equal((await read(wire, session)).error, undefined);
  const mark = wire.sent.length;
  assert.equal((await read(wire, session)).error, undefined);
  assert.deepEqual(
    privateTrees(wire, mark),
    [],
    'matching fresh guard evidence is independent of immutable caller reply generations'
  );
});
