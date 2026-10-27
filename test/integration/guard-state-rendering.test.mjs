import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, protocol } from './guard-state-fixture.mjs';

for (const scope of ['document', 'parent']) {
  for (const [method, params, result] of [
    ['Page.printToPDF', {}, { data: Buffer.from(failed).toString('base64') }],
    [
      'HeadlessExperimental.beginFrame',
      { screenshot: { format: 'png' } },
      { screenshotData: Buffer.from(failed).toString('base64'), hasDamage: true },
    ],
    ['Page.startScreencast', {}, {}],
  ]) {
    test(`state rendering ${scope} ${method}`, async (t) => {
      const wire = protocol(t);
      wire.target('rendering');
      const session = await wire.attach('rendering');
      const frame =
        scope === 'document' ? errorFrame('rendering') : errorFrame('rendering-child', 'rendering');
      wire.emit({ method: 'Page.frameNavigated', sessionId: 'guard-rendering', params: { frame } });
      await flush();
      const mark = wire.sent.length;
      wire.hold((message) => message.id < 2 ** 30 && message.method === method);
      const read = wire.request(method, params, session);
      await flush();
      const held = wire.held.find((message) => message.id === read.id);
      if (held) wire.release(held, { result });
      const answer = await read.answer;
      assert.deepEqual(
        wire.clients(mark).filter((message) => message.id === read.id),
        []
      );
      assert.match(answer.error?.message ?? '', /^slicc: refused:/);
      assert.equal(answer.result, undefined);
    });
  }
  test(`state rendering ${scope} publication`, async (t) => {
    const wire = protocol(t);
    wire.target('rendering-event');
    const session = await wire.attach('rendering-event');
    await wire.send('Page.enable', {}, session);
    const frame =
      scope === 'document'
        ? errorFrame('rendering-event')
        : errorFrame('rendering-event-child', 'rendering-event');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-rendering-event',
      params: { frame },
    });
    await flush();
    const mark = wire.delivered.length;
    wire.emit({
      method: 'Page.screencastFrame',
      sessionId: session,
      params: { data: 'synthetic-rendered-state', sessionId: 1, metadata: {} },
    });
    await flush();
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-rendered-state'),
      false
    );
    assert.equal((await wire.send('Page.stopScreencast', {}, session)).error, undefined);
  });
}
