import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, ordinary, plainFrame, protectedOrigin, protocol } from './guard-state-fixture.mjs';

const marker = 'synthetic-protected-document-content';
const protectedInfo = (entry) => {
  entry.info.url = `${protectedOrigin}/private`;
  return { method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } };
};
const body = (sessionId) => ({
  method: 'DOM.childNodeInserted',
  sessionId,
  params: {
    parentNodeId: 1,
    previousNodeId: 0,
    node: { nodeId: 2, nodeType: 3, nodeName: '#text', nodeValue: marker },
  },
});
const detached = (wire, sessionId, mark) =>
  wire.sent
    .slice(mark)
    .some(
      (message) =>
        message.method === 'Target.detachFromTarget' && message.params.sessionId === sessionId
    );

function cleanup(t, wire) {
  t.after(() => {
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
  });
}

test('restored probe a protected frame cuts even when target information cannot be checked', async (t) => {
  const wire = protocol(t);
  cleanup(t, wire);
  const entry = wire.target('failed-info');
  const session = await wire.attach('failed-info');
  entry.tree.frame = {
    ...plainFrame('failed-info'),
    url: `${protectedOrigin}/private`,
    securityOrigin: protectedOrigin,
  };
  wire.hold((message) => {
    if (message.method !== 'Target.getTargetInfo') return false;
    queueMicrotask(() =>
      wire.release(message, { error: { code: -32000, message: 'target information unavailable' } })
    );
    return true;
  });
  const mark = wire.sent.length;
  wire.emit(protectedInfo(entry));
  await flush();
  const receipt = wire.delivered.length;
  wire.emit(body(session));
  await flush();
  assert.equal(detached(wire, session, mark), true);
  assert.equal(JSON.stringify(wire.delivered.slice(receipt)).includes(marker), false);
});

test('restored probe document events are not published while a tree has not answered', async (t) => {
  const wire = protocol(t);
  cleanup(t, wire);
  const entry = wire.target('pending-tree');
  const session = await wire.attach('pending-tree');
  await wire.send('Page.enable', {}, session);
  entry.tree.frame = {
    ...plainFrame('pending-tree'),
    url: `${protectedOrigin}/private`,
    securityOrigin: protectedOrigin,
  };
  wire.hold((message) => message.method === 'Page.getFrameTree');
  const mark = wire.sent.length;
  wire.emit(protectedInfo(entry));
  await flush();
  const receipt = wire.delivered.length;
  wire.emit(body(session));
  wire.emit({
    method: 'Page.screencastFrame',
    sessionId: session,
    params: { data: 'c3ludGhldGlj', metadata: {}, sessionId: 1 },
  });
  await flush();
  assert.equal(
    wire.delivered
      .slice(receipt)
      .some(
        (message) =>
          message.method === 'DOM.childNodeInserted' || message.method === 'Page.screencastFrame'
      ),
    false
  );
  if (wire.held.length) wire.release(wire.held[0]);
  await flush();
  assert.equal(detached(wire, session, mark), true);
});

test('restored probe an unanswered tree does not hold later browser target events', async (t) => {
  const wire = protocol(t);
  cleanup(t, wire);
  const entry = wire.target('slow-target');
  await wire.attach('slow-target');
  wire.hold((message) => message.method === 'Page.getFrameTree');
  wire.emit(protectedInfo(entry));
  await flush();
  entry.info.url = ordinary;
  const later = wire.target('later-target');
  const mark = wire.delivered.length;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  wire.emit({ method: 'Target.targetCreated', params: { targetInfo: later.info } });
  await flush();
  assert.equal(
    wire.delivered
      .slice(mark)
      .some(
        (message) =>
          message.method === 'Target.targetCreated' &&
          message.params.targetInfo.targetId === 'later-target'
      ),
    true
  );
});

for (const payload of [{ error: { code: -32000, message: 'tree unavailable' } }, { result: {} }]) {
  test(`restored probe a failed or empty tree cuts ${Boolean(payload.error)}`, async (t) => {
    const wire = protocol(t);
    cleanup(t, wire);
    const entry = wire.target('missing-tree');
    const session = await wire.attach('missing-tree');
    wire.hold((message) => {
      if (message.method !== 'Page.getFrameTree') return false;
      queueMicrotask(() => wire.release(message, payload));
      return true;
    });
    const mark = wire.sent.length;
    wire.emit(protectedInfo(entry));
    await flush();
    assert.equal(detached(wire, session, mark), true);
  });
}
