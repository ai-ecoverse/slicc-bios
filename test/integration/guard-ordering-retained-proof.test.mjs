import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

async function wiped(t, id) {
  const wire = protocol(t);
  const entry = wire.target(id);
  const session = await wire.attach(id);
  assert.equal((await wire.send('Page.enable', {}, session)).error, undefined);
  assert.equal((await wire.send('Runtime.enable', {}, session)).error, undefined);
  entry.info.url = failed;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
  await flush();
  await flush();
  entry.tree = { frame: { ...errorFrame(id), loaderId: 'failed-loader' } };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${id}`,
    params: { frame: entry.tree.frame },
  });
  entry.info.url = BLANKED;
  entry.tree = { frame: { id, loaderId: 'blank-loader', url: BLANKED, securityOrigin: '://' } };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: `guard-${id}`,
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
  await flush();
  await flush();
  return { wire, entry, session };
}

const detached = (wire, session, mark = 0) =>
  wire.sent
    .slice(mark)
    .some(
      (message) =>
        message.method === 'Target.detachFromTarget' && message.params.sessionId === session
    );

for (const kind of ['live-protected', 'held-parent', 'lent-opener']) {
  test(`residual a shown caller is cut for ${kind} metadata despite an older guard blank`, {
    timeout: 5000,
  }, async (t) => {
    const id = `retained-${kind}`;
    const { wire, entry, session } = await wiped(t, id);
    const opener = wire.target(`${id}-opener`);
    opener.info.url = failed;
    if (kind === 'live-protected') entry.info.url = failed;
    if (kind === 'held-parent') {
      const parent = wire.target(`${id}-parent`);
      parent.info.url = 'about:blank';
      parent.info.openerId = opener.info.targetId;
      parent.info.canAccessOpener = true;
      entry.info.parentId = parent.info.targetId;
    }
    if (kind === 'lent-opener') {
      entry.info.openerId = opener.info.targetId;
      entry.info.canAccessOpener = true;
    }
    const mark = wire.sent.length;
    const answer = await wire.send('Runtime.evaluate', {}, session);
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(detached(wire, session, mark), true);
    assert.equal(
      wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
      false
    );
  });
}

for (const kind of [
  'stale-loader',
  'child',
  'private-error',
  'unanswered',
  'protected-during-proof',
]) {
  test(`residual a guard blank does not retain a shown caller on ${kind} proof`, {
    timeout: 5000,
  }, async (t) => {
    const id = `retained-proof-${kind}`;
    const { wire, entry, session } = await wiped(t, id);
    if (kind === 'stale-loader') entry.tree.frame.loaderId = 'uncommitted-loader';
    if (kind === 'child') entry.tree.childFrames = [{ frame: plainFrame(`${id}-child`, id) }];
    if (['private-error', 'unanswered', 'protected-during-proof'].includes(kind))
      wire.hold(
        (message) => message.method === 'Page.getFrameTree' && message.sessionId === `guard-${id}`
      );
    const mark = wire.sent.length;
    const started = Date.now();
    const request = wire.request('Runtime.evaluate', {}, session);
    if (kind === 'private-error') {
      await flush();
      wire.release(wire.held[0], {
        error: { code: -32000, message: 'synthetic blank proof failure' },
      });
    }
    if (kind === 'protected-during-proof') {
      await flush();
      const pending = wire.held[0];
      const before = structuredClone(entry.tree);
      entry.tree = {
        frame: {
          id,
          loaderId: 'protected-loader',
          url: failed,
          securityOrigin: new URL(failed).origin,
        },
      };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: `guard-${id}`,
        params: { frame: entry.tree.frame },
      });
      wire.release(pending, { result: { frameTree: before } });
    }
    const answer = await request.answer;
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.ok(Date.now() - started < 2000);
    assert.equal(detached(wire, session, mark), true);
    assert.equal(
      wire.clients(mark).some((message) => message.method === 'Runtime.evaluate'),
      false
    );
  });
}

test('residual a kept caller is cut on a protected commit before any frame or content event', {
  timeout: 5000,
}, async (t) => {
  const { wire, entry, session } = await wiped(t, 'kept-commit');
  await wire.send('Page.enable', {}, session);
  await wire.send('Runtime.enable', {}, session);
  assert.match(
    (await wire.send('Runtime.evaluate', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
  assert.equal(detached(wire, session), false);
  const sent = wire.sent.length;
  const received = wire.delivered.length;
  entry.info.url = failed;
  entry.tree = {
    frame: {
      id: 'kept-commit',
      loaderId: 'protected-loader',
      url: failed,
      securityOrigin: new URL(failed).origin,
    },
  };
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: session,
    params: { frame: entry.tree.frame },
  });
  wire.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId: session,
    params: { type: 'log', args: [{ type: 'string', value: 'synthetic-protected-content' }] },
  });
  wire.emit({
    method: 'Page.frameStoppedLoading',
    sessionId: session,
    params: { frameId: 'kept-commit' },
  });
  await flush();
  await flush();
  assert.equal(detached(wire, session, sent), true);
  assert.equal(
    wire.delivered
      .slice(received)
      .some(
        (message) =>
          message.method?.startsWith('Page.frame') || message.method?.startsWith('Runtime.')
      ),
    false
  );
  assert.match(
    (await wire.send('Runtime.evaluate', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
  assert.equal(
    wire.clients(sent).some((message) => message.method === 'Runtime.evaluate'),
    false
  );
});

for (const root of ['wiped', 'wiped-frame']) {
  test(`residual a guard-wiped caller retains its blank screenshot ${root}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('wiped', 'page', plainFrame(root));
    const session = await wire.attach('wiped');
    entry.info.url = failed;
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
    await flush();
    await flush();
    entry.tree = { frame: { ...errorFrame(root), loaderId: 'failed-loader' } };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-wiped',
      params: { frame: entry.tree.frame },
    });
    await flush();
    assert.match(
      (await wire.send('Runtime.evaluate', {}, session)).error?.message ?? '',
      /^slicc: refused:/
    );
    entry.info.url = BLANKED;
    entry.tree = {
      frame: { id: root, loaderId: 'blank-loader', url: BLANKED, securityOrigin: '://' },
    };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: entry.tree.frame },
    });
    assert.match(
      (await wire.send('Page.captureScreenshot', {}, session)).error?.message ?? '',
      /^slicc: refused:/
    );
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-wiped',
      params: { frame: entry.tree.frame },
    });
    wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...entry.info } } });
    await flush();
    await flush();
    const mark = wire.sent.length;
    const answer = await wire.send('Runtime.evaluate', {}, session);
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(
      wire.sent
        .slice(mark)
        .some((message) => message.method === 'Runtime.evaluate' && message.id < 2 ** 30),
      false
    );
    assert.equal(
      wire.sent
        .slice(mark)
        .some(
          (message) =>
            message.method === 'Target.detachFromTarget' && message.params.sessionId === session
        ),
      false
    );
    assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error, undefined);
  });
}

test('residual an unshown attachment with protected fresh metadata is still detached', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('unshown');
  const session = wire.attached('unshown');
  entry.info.url = failed;
  await flush();
  await flush();
  assert.ok(
    wire.sent.some(
      (message) =>
        message.method === 'Target.detachFromTarget' && message.params.sessionId === session
    )
  );
  assert.match(
    (await wire.send('Runtime.evaluate', {}, session)).error?.message ?? '',
    /^slicc: refused:/
  );
});
