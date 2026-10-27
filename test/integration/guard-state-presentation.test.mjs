import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

for (const [kind, value] of [
  ['empty', ''],
  ['invalid', '://'],
  ['null', null],
  ['token', 'synthetic-unknown-state'],
]) {
  for (const method of ['Page.getFrameTree', 'Page.getResourceTree']) {
    test(`state presentation ${kind} ${method}`, async (t) => {
      const wire = protocol(t);
      const entry = wire.target('presentation');
      const session = await wire.attach('presentation');
      entry.tree = { frame: { ...errorFrame('presentation'), unreachableUrl: value } };
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-presentation',
        params: { frame: entry.tree.frame },
      });
      wire.hold((message) => message.id < 2 ** 30 && message.method === method);
      const read = wire.request(method, {}, session);
      await flush();
      const held = wire.held.find((message) => message.id === read.id);
      assert.ok(held);
      wire.release(held, { result: { frameTree: entry.tree } });
      const answer = await read.answer;
      assert.equal(answer.error, undefined);
      assert.equal(Object.hasOwn(answer.result.frameTree.frame, 'unreachableUrl'), false);
      assert.equal(answer.result.frameTree.frame.url, 'chrome-error://chromewebdata/');
    });
  }
  test(`state presentation events ${kind}`, async (t) => {
    const wire = protocol(t);
    wire.target('presentation-parent');
    const session = await wire.attach('presentation-parent');
    await wire.send('Page.enable', {}, session);
    await wire.send('Log.enable', {}, session);
    const mark = wire.delivered.length;
    const frame = {
      ...errorFrame('presentation-child', 'presentation-parent'),
      unreachableUrl: value,
    };
    wire.emit({ method: 'Page.frameNavigated', sessionId: session, params: { frame } });
    wire.emit({
      method: 'Log.entryAdded',
      sessionId: session,
      params: {
        entry: {
          source: 'javascript',
          level: 'error',
          text: 'synthetic-unsafe-log',
          timestamp: 1,
          url: 'chrome-error://chromewebdata/',
        },
      },
    });
    await flush();
    const navigation = wire.delivered
      .slice(mark)
      .find(
        (message) =>
          message.method === 'Page.frameNavigated' && message.params?.frame?.id === frame.id
      );
    assert.ok(navigation);
    assert.equal(navigation.params.frame.unreachableUrl, 'chrome-error://chromewebdata/');
    assert.equal(navigation.params.frame.url, 'chrome-error://chromewebdata/');
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-unsafe-log'),
      false
    );
  });
}

for (const failure of [
  { error: { code: -32000, message: 'synthetic missing presentation' } },
  { result: {} },
]) {
  for (const value of [failed, '://']) {
    test(`state presentation unbound ${failure.error ? 'error' : 'empty'} ${value === failed ? 'named' : 'unknown'}`, async (t) => {
      const wire = protocol(t);
      wire.target('unbound-presentation', 'page', plainFrame('unbound-root'));
      wire.hold((message) => message.id < 2 ** 30 && message.method === 'Target.attachToTarget');
      const read = wire.request('Target.attachToTarget', {
        targetId: 'unbound-presentation',
        flatten: true,
      });
      await flush();
      const held = wire.held.find((message) => message.id === read.id);
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-unbound-presentation',
        params: {
          frame: { ...errorFrame('unbound-child', 'unbound-root'), unreachableUrl: value },
        },
      });
      wire.hold((message) => message.method === 'Page.getFrameTree');
      wire.release(held);
      await flush();
      const proof = wire.held.find((message) => message.method === 'Page.getFrameTree');
      assert.ok(proof);
      wire.release(proof, failure);
      const attachment = await read.answer;
      assert.match(attachment.error?.message ?? '', /^slicc: refused:/);
      const shot = await wire.send('Page.captureScreenshot', {}, 'client-unbound-presentation');
      assert.match(shot.error?.message ?? '', /^slicc: refused:/);
      assert.equal(shot.result, undefined);
    });
  }
}
