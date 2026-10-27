import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-state-fixture.mjs';

for (const shape of ['wide', 'deep']) {
  for (const related of [false, true]) {
    test(`state large event ${shape} related ${related}`, async (t) => {
      const wire = protocol(t);
      wire.target('large-owner');
      wire.target('large-ordinary');
      const owner = await wire.attach('large-owner');
      const unrelated = await wire.attach('large-ordinary');
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-large-owner',
        params: { frame: errorFrame('large-unsafe', 'large-owner') },
      });
      await flush();
      let details = { marker: 'ordinary-large-event' };
      if (shape === 'wide')
        details = Object.fromEntries(
          Array.from({ length: 5000 }, (_, index) => [`field-${index}`, 'ordinary-large-event'])
        );
      else for (let index = 0; index < 4100; index += 1) details = { next: details };
      const method = shape === 'wide' ? 'Audits.issueAdded' : 'Tracing.dataCollected';
      const params =
        shape === 'wide'
          ? { issue: { code: 'GenericIssue', details } }
          : { value: [{ name: 'ordinary-trace', args: details }] };
      const mark = wire.delivered.length;
      wire.emit({ method, sessionId: related ? owner : unrelated, params });
      await flush();
      const event = wire.delivered.slice(mark).find((message) => message.method === method);
      if (related) assert.equal(event, undefined);
      else {
        assert.ok(event);
        assert.equal(JSON.stringify(event.params), JSON.stringify(params));
      }
    });
  }
}

const dialogs = [
  [
    'Page.javascriptDialogOpening',
    {
      url: ordinary,
      message: 'ordinary-dialog',
      type: 'prompt',
      hasBrowserHandler: true,
      defaultPrompt: 'ordinary-default',
    },
    'message',
  ],
  ['Page.javascriptDialogClosed', { result: true, userInput: 'ordinary-input' }, 'userInput'],
  [
    'Page.windowOpen',
    { url: ordinary, windowName: 'ordinary-window', windowFeatures: [], userGesture: true },
    'windowName',
  ],
];

for (const [method, ordinaryParams, field] of dialogs) {
  test(`state ordinary frameless ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('dialog-owner');
    const session = await wire.attach('dialog-owner');
    await wire.send('Page.enable', {}, session);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-dialog-owner',
      params: { frame: errorFrame('dialog-unsafe', 'dialog-owner') },
    });
    await flush();
    const mark = wire.delivered.length;
    wire.emit({ method, sessionId: session, params: ordinaryParams });
    await flush();
    const event = wire.delivered.slice(mark).find((message) => message.method === method);
    assert.ok(event);
    assert.deepEqual(event.params, ordinaryParams);
  });

  test(`state frameless failed receipt ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('receipt-dialog-owner');
    const session = await wire.attach('receipt-dialog-owner');
    await wire.send('Page.enable', {}, session);
    const unreachableUrl = 'synthetic-receipt-failed-url';
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-receipt-dialog-owner',
      params: {
        frame: { ...errorFrame('receipt-dialog-unsafe', 'receipt-dialog-owner'), unreachableUrl },
      },
    });
    await flush();
    const mark = wire.delivered.length;
    const params = { ...ordinaryParams, [field]: unreachableUrl };
    wire.emit({ method, sessionId: session, params });
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-receipt-dialog-owner',
      params: { frame: plainFrame('receipt-dialog-unsafe', 'receipt-dialog-owner') },
    });
    await flush();
    assert.equal(
      wire.delivered.slice(mark).some((message) => message.method === method),
      false
    );
    wire.emit({ method, sessionId: session, params });
    await flush();
    const event = wire.delivered.slice(mark).find((message) => message.method === method);
    assert.ok(event);
    assert.deepEqual(event.params, params);
  });

  for (const unreachableUrl of [failed, 'synthetic-unknown-failed-url']) {
    test(`state frameless failed URL ${method} ${unreachableUrl === failed ? 'protected' : 'unknown'}`, async (t) => {
      const wire = protocol(t);
      wire.target('failed-dialog-owner');
      const session = await wire.attach('failed-dialog-owner');
      await wire.send('Page.enable', {}, session);
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-failed-dialog-owner',
        params: {
          frame: { ...errorFrame('failed-dialog-unsafe', 'failed-dialog-owner'), unreachableUrl },
        },
      });
      await flush();
      const mark = wire.delivered.length;
      wire.emit({
        method,
        sessionId: session,
        params: { ...ordinaryParams, [field]: unreachableUrl },
      });
      await flush();
      assert.equal(
        wire.delivered.slice(mark).some((message) => message.method === method),
        false
      );
      assert.equal(JSON.stringify(wire.delivered.slice(mark)).includes(unreachableUrl), false);
    });
  }
}

test('state large resources on an unrelated page remain live', async (t) => {
  const wire = protocol(t);
  wire.target('resource-error-owner');
  wire.target('resource-ordinary-owner');
  await wire.attach('resource-error-owner');
  const session = await wire.attach('resource-ordinary-owner');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-resource-error-owner',
    params: { frame: errorFrame('resource-error-child', 'resource-error-owner') },
  });
  await flush();
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.getResourceTree');
  const read = wire.request('Page.getResourceTree', {}, session);
  await flush();
  const resource = {
    url: ordinary,
    type: 'Script',
    details: Array(5000).fill('ordinary-resource'),
  };
  wire.release(
    wire.held.find((message) => message.id === read.id),
    {
      result: {
        frameTree: {
          frame: plainFrame('resource-ordinary-owner'),
          childFrames: [
            {
              frame: plainFrame('resource-ordinary-child', 'resource-ordinary-owner'),
              resources: [resource],
            },
          ],
        },
      },
    }
  );
  const answer = await read.answer;
  assert.equal(answer.error, undefined);
  assert.deepEqual(answer.result.frameTree.childFrames[0].resources, [resource]);
});
