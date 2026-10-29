import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, plainFrame, protectedOrigin, protocol } from './guard-ordering-fixture.mjs';

for (const securityOrigin of ['', '://']) {
  test(`residual a loading root with origin ${JSON.stringify(securityOrigin)} is re-queried before attachment`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('loading-root');
    wire.hold(
      (message) =>
        message.method === 'Page.getFrameTree' && message.sessionId === 'client-loading-root'
    );
    const attachment = wire.request('Target.attachToTarget', {
      targetId: 'loading-root',
      flatten: true,
    });
    await flush();
    await flush();
    const probe = wire.held.find((message) => message.sessionId === 'client-loading-root');
    assert.ok(probe);
    wire.hold(() => false);
    wire.release(probe, {
      result: { frameTree: { frame: { id: 'loading-root', url: '', securityOrigin } } },
    });
    const answer = await attachment.answer;
    assert.equal(answer.error, undefined);
    assert.equal(answer.result?.sessionId, 'client-loading-root');
    assert.equal(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: 'document.title' },
          answer.result.sessionId
        )
      ).error,
      undefined
    );
  });

  test(`residual a root that stays loading with origin ${JSON.stringify(securityOrigin)} is never admitted`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('unsettled-root');
    entry.tree.frame = { id: 'unsettled-root', url: '', securityOrigin };
    const started = Date.now();
    const answer = await wire.send('Target.attachToTarget', {
      targetId: 'unsettled-root',
      flatten: true,
    });
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.ok(Date.now() - started < 2500);
    const attempts = wire.sent.filter(
      (message) =>
        message.method === 'Page.getFrameTree' && message.sessionId === 'client-unsettled-root'
    ).length;
    assert.ok(attempts >= 1 && attempts <= 25);
    const before = wire.sent.length;
    assert.match(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: 'document.title' },
          'client-unsettled-root'
        )
      ).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.deepEqual(wire.clients(before), []);
    wire.target('unrelated-root');
    assert.equal(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: '1' },
          await wire.attach('unrelated-root')
        )
      ).error,
      undefined
    );
  });
}

for (const next of ['protected', 'malformed', 'missing']) {
  test(`residual a loading root followed by ${next} metadata stays closed`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('negative-root');
    wire.hold(
      (message) =>
        message.method === 'Page.getFrameTree' && message.sessionId === 'client-negative-root'
    );
    const attachment = wire.request('Target.attachToTarget', {
      targetId: 'negative-root',
      flatten: true,
    });
    await flush();
    await flush();
    const probe = wire.held.find((message) => message.sessionId === 'client-negative-root');
    assert.ok(probe);
    entry.tree.frame =
      next === 'protected'
        ? {
            ...plainFrame('negative-root'),
            url: `${protectedOrigin}/private`,
            securityOrigin: protectedOrigin,
          }
        : {
            ...plainFrame('negative-root'),
            securityOrigin: next === 'missing' ? undefined : 'bad-origin',
          };
    wire.hold(() => false);
    wire.release(probe, {
      result: { frameTree: { frame: { id: 'negative-root', url: '', securityOrigin: '' } } },
    });
    const answer = await attachment.answer;
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    const before = wire.sent.length;
    assert.match(
      (
        await wire.send(
          'Runtime.evaluate',
          { expression: 'document.title' },
          'client-negative-root'
        )
      ).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.deepEqual(wire.clients(before), []);
  });
}
