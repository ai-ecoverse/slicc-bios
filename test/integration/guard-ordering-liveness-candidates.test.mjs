import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLANKED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-ordering-fixture.mjs';

const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
const refuse = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};
const context = (wire, session, id, uniqueId) =>
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id,
        uniqueId,
        origin: new URL(ordinary).origin,
        name: '',
        auxData: { frameId: 'owner', isDefault: true, type: 'default' },
      },
    },
  });

for (const kind of ['ordinary', 'protected']) {
  test(`ordering attachment notices change scope only for evidence ${kind}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('owner');
    const session = await wire.attach('owner');
    await read(wire, session);
    wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
    const shot = wire.request('Page.captureScreenshot', {}, session);
    await flush();
    const pending = wire.held.find((message) => message.id === shot.id);
    wire.sessions.set('second-owner', 'owner');
    const targetInfo = kind === 'ordinary' ? entry.info : { ...entry.info, url: failed };
    wire.emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'second-owner', targetInfo, waitingForDebugger: false },
    });
    await flush();
    await flush();
    wire.release(pending);
    const answer = await shot.answer;
    if (kind === 'ordinary')
      assert.equal(
        answer.error,
        undefined,
        'a new ordinary client session did not replace the document'
      );
    else refuse(answer);
  });
}

for (const kind of ['ordinary', 'protected']) {
  test(`ordering current positive attachment spends first proof ${kind}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('owner');
    const session = await wire.attach('owner');
    assert.equal((await wire.send('Page.getFrameTree', {}, session)).error, undefined);
    wire.hold(
      (message) => message.sessionId === 'guard-owner' && message.method === 'Page.getFrameTree'
    );
    if (kind === 'protected') {
      entry.tree = { frame: errorFrame('owner') };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: entry.tree.frame },
      });
    }
    const mark = wire.sent.length;
    const command = read(wire, session);
    await flush();
    const proof = wire.held.find((message) => message.method === 'Page.getFrameTree');
    if (proof)
      wire.release(proof, {
        error: { code: -32000, message: 'synthetic unavailable redundant proof' },
      });
    const answer = await command;
    if (kind === 'ordinary') {
      assert.equal(
        proof,
        undefined,
        'a current own tree obtained for the tree handshake spends the first proof'
      );
      assert.equal(answer.error, undefined);
    } else {
      assert.ok(proof);
      refuse(answer);
      assert.deepEqual(wire.clients(mark), []);
    }
  });
}

for (const kind of ['ordinary', 'protected']) {
  test(`ordering root cleanup reconciles only an independently observed failed URL ${kind}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('owner');
    const session = await wire.attach('owner');
    await read(wire, session);
    if (kind === 'ordinary') {
      entry.tree = { frame: errorFrame('owner') };
      wire.hold((message) => message.id >= 2 ** 30 && message.method === 'Page.navigate');
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-owner',
        params: { frame: entry.tree.frame },
      });
      await flush();
      const navigation = wire.held.find((message) => message.method === 'Page.navigate');
      assert.ok(navigation);
      entry.tree = { frame: { ...plainFrame('owner'), url: BLANKED, securityOrigin: '://' } };
      wire.hold(() => false);
      wire.release(navigation, { result: { frameId: 'owner' } });
      await flush();
      await flush();
    } else {
      entry.tree = { frame: { ...plainFrame('owner'), url: failed } };
    }
    entry.info.url = failed;
    const mark = wire.sent.length;
    const answer = await wire.send('Target.closeTarget', { targetId: 'owner' });
    if (kind === 'ordinary')
      assert.equal(
        answer.error,
        undefined,
        'the failed URL belongs to the independently verified blanked error document'
      );
    else {
      refuse(answer);
      assert.deepEqual(wire.clients(mark), []);
    }
  });
}

for (const kind of ['ordinary', 'protected']) {
  test(`ordering fresh context notification replaces no stale receipt ${kind}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('owner');
    const session = await wire.attach('owner');
    await wire.send('Runtime.enable', {}, session);
    await read(wire, session);
    wire.hold(
      (message) =>
        message.id >= 2 ** 30 &&
        (message.method === 'Runtime.enable' ||
          (message.method === 'Runtime.evaluate' && message.params.expression === 'location.href'))
    );
    context(wire, session, 51, 'synthetic-old-positive-realm');
    await flush();
    const realm = wire.held.find((message) => message.method === 'Runtime.evaluate');
    assert.ok(realm);
    if (kind === 'ordinary')
      wire.emit({
        method: 'Page.frameAttached',
        sessionId: 'guard-owner',
        params: { frameId: 'pending', parentFrameId: 'owner' },
      });
    else {
      entry.tree = { frame: errorFrame('owner') };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: session,
        params: { frame: entry.tree.frame },
      });
    }
    wire.release(realm, { result: { result: { value: ordinary } } });
    await flush();
    assert.equal(
      wire.delivered.some(
        (message) =>
          message.method === 'Runtime.executionContextCreated' && message.params.context.id === 51
      ),
      false
    );
    const current = await read(wire, session);
    await flush();
    const enable = wire.held.find((message) => message.method === 'Runtime.enable');
    if (kind === 'ordinary') {
      assert.equal(current.error, undefined);
      assert.ok(
        enable,
        'current proof requests a new source notification, not replay of the old receipt'
      );
      context(wire, session, 52, 'synthetic-current-positive-realm');
      wire.release(enable);
      wire.hold(() => false);
      for (const pending of [...wire.held]) wire.release(pending);
      await flush();
      await flush();
      assert.ok(
        wire.delivered.some(
          (message) =>
            message.method === 'Runtime.executionContextCreated' && message.params.context.id === 52
        )
      );
      assert.equal(
        wire.delivered.some(
          (message) =>
            message.method === 'Runtime.executionContextCreated' && message.params.context.id === 51
        ),
        false
      );
    } else {
      refuse(current);
      assert.equal(enable, undefined);
    }
  });
}
