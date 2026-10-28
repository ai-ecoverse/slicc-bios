import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  guardProtected,
  ordinary,
  protocol,
} from './guard-state-fixture.mjs';

async function pendingScrub(t, id) {
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
  const client = await wire.attach(id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.emit({
    method: 'Fetch.requestPaused',
    sessionId: `guard-${id}`,
    params: {
      requestId: 'race-failed',
      frameId: id,
      resourceType: 'Document',
      request: { url: failed },
    },
  });
  await flush();
  entry.tree.frame = { ...errorFrame(id), loaderId: 'race-error-loader' };
  entry.info.url = failed;
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
  return {
    wire,
    entry,
    client,
    connection,
    closed: () => closed,
    blanks: () =>
      wire.sent.filter(
        (message) => message.method === 'Page.navigate' && message.params.url === BLANKED
      ),
  };
}

for (const method of [
  'Page.navigate',
  'Page.reload',
  'Page.navigateToHistoryEntry',
  'Target.closeTarget',
]) {
  test(`state closing cancels an already-checking client ${method} without cancelling the protected scrub`, async (t) => {
    const id = `close-client-${method.replaceAll('.', '-')}`;
    const state = await pendingScrub(t, id);
    state.entry.history = {
      currentIndex: 0,
      entries: [
        { id: 1, url: failed, title: 'failed' },
        { id: 2, url: ordinary, title: 'ordinary' },
      ],
    };
    state.wire.hold(
      (message) => message.method === 'Page.getFrameTree' && message.sessionId === `guard-${id}`
    );
    const params =
      method === 'Page.navigate'
        ? { url: ordinary }
        : method === 'Page.navigateToHistoryEntry'
          ? { entryId: 2 }
          : method === 'Target.closeTarget'
            ? { targetId: id }
            : {};
    state.wire.request(method, params, method === 'Target.closeTarget' ? undefined : state.client);
    await flush();
    const callerProof = state.wire.held.find((message) => message.method === 'Page.getFrameTree');
    assert.ok(callerProof);
    state.connection.close();
    await flush();
    const closeProof = state.wire.held.find(
      (message) => message !== callerProof && message.method === 'Page.getFrameTree'
    );
    assert.ok(closeProof);
    state.wire.release(callerProof, { result: { frameTree: state.entry.tree } });
    await flush();
    assert.equal(
      state.wire.clients().filter((message) => message.method === method).length,
      0,
      'the departed client command is never written'
    );
    state.wire.release(closeProof, { result: { frameTree: state.entry.tree } });
    await flush();
    assert.equal(state.blanks().length, 1);
    assert.equal(state.closed(), 1);
  });
}

test('state closing cancels the private destination of an already-created client tab', async (t) => {
  const id = 'close-created-race';
  const state = await pendingScrub(t, id);
  const created = 'closed-client-created-tab';
  state.wire.target(created, 'page', {
    id: created,
    url: 'about:blank',
    securityOrigin: 'null',
    loaderId: 'created-blank-loader',
  });
  let paused = false;
  state.wire.hold((message) => {
    if (message.method === 'Target.createTarget') {
      queueMicrotask(() => state.wire.release(message, { result: { targetId: created } }));
      return true;
    }
    if (message.method === 'Page.enable' && message.sessionId === `guard-${created}` && !paused) {
      paused = true;
      return true;
    }
    return message.method === 'Page.getFrameTree' && message.sessionId === `guard-${id}`;
  });
  state.wire.request('Target.createTarget', { url: ordinary });
  await flush();
  const arming = state.wire.held.find((message) => message.method === 'Page.enable');
  assert.ok(arming);
  state.connection.close();
  await flush();
  const closeProof = state.wire.held.find((message) => message.method === 'Page.getFrameTree');
  assert.ok(closeProof);
  state.wire.release(arming);
  await flush();
  assert.equal(
    state.wire.sent.filter(
      (message) => message.method === 'Page.navigate' && message.params.url === ordinary
    ).length,
    0
  );
  state.wire.release(closeProof, { result: { frameTree: state.entry.tree } });
  await flush();
  assert.equal(state.blanks().length, 1);
  assert.equal(state.closed(), 1);
});

test('state a placement continuation writes nothing after the close deadline', async (t) => {
  const id = 'close-placement-cap';
  const state = await pendingScrub(t, id);
  state.wire.hold(
    (message) => message.method === 'Page.enable' && message.sessionId === `guard-${id}`
  );
  state.wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${id}`,
    params: { frame: state.entry.tree.frame },
  });
  await flush();
  const placing = state.wire.held.find((message) => message.method === 'Page.enable');
  assert.ok(placing);
  state.connection.close();
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(state.closed(), 1);
  const mark = state.wire.sent.length;
  state.wire.release(placing);
  await flush();
  t.mock.timers.tick(15000);
  await flush();
  assert.equal(
    state.wire.sent.length,
    mark,
    'no private tree or DOM command is sent after the cap'
  );
  assert.equal(state.blanks().length, 0);
  assert.equal(state.closed(), 1);
});
