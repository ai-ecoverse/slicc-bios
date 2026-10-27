import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, flush, ordinary, plainFrame, protocol } from './guard-state-fixture.mjs';

for (const announced of [false, true]) {
  test(`state first containing authority ${announced}`, async (t) => {
    const wire = protocol(t);
    wire.target('first-authority', 'iframe', plainFrame('authority-root', 'outer-root'));
    if (announced)
      wire.emit({
        method: 'Target.targetCreated',
        params: { targetInfo: wire.targets.get('first-authority').info },
      });
    wire.hold((message) => message.id < 2 ** 30 && message.method === 'Target.attachToTarget');
    const read = wire.request('Target.attachToTarget', {
      targetId: 'first-authority',
      flatten: true,
    });
    await flush();
    const held = wire.held.find((message) => message.id === read.id);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-first-authority',
      params: { frame: plainFrame('first-sibling', 'authority-root') },
    });
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-first-authority',
      params: { frame: { ...errorFrame('first-unsafe', 'authority-root'), unreachableUrl: '://' } },
    });
    wire.hold((message) => message.method === 'Page.getFrameTree');
    wire.release(held);
    await flush();
    wire.release(
      wire.held.find((message) => message.method === 'Page.getFrameTree'),
      { result: {} }
    );
    const attachment = await read.answer;
    assert.match(attachment.error?.message ?? '', /^slicc: refused:/);
    const shot = await wire.send('Page.captureScreenshot', {}, 'client-first-authority');
    assert.match(shot.error?.message ?? '', /^slicc: refused:/);
    assert.equal(shot.result, undefined);
  });
}

for (const method of ['Page.getFrameTree', 'Page.getResourceTree']) {
  test(`state unsafe resources ${method}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('resource-owner');
    const session = await wire.attach('resource-owner');
    const frame = { ...errorFrame('resource-child', 'resource-owner'), unreachableUrl: '://' };
    entry.tree.childFrames = [
      {
        frame,
        resources: [
          { url: '://', type: 'Document' },
          { url: ordinary, type: 'Script' },
        ],
      },
    ];
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-resource-owner',
      params: { frame },
    });
    wire.hold((message) => message.id < 2 ** 30 && message.method === method);
    const read = wire.request(method, {}, session);
    await flush();
    wire.release(
      wire.held.find((message) => message.id === read.id),
      { result: { frameTree: entry.tree } }
    );
    const answer = await read.answer;
    assert.equal(answer.error, undefined);
    assert.deepEqual(answer.result.frameTree.childFrames[0].resources, []);
  });
}

for (const [method, params] of [
  [
    'Page.frameStartedNavigating',
    {
      frameId: 'named-unsafe',
      url: 'synthetic-unsafe-event',
      loaderId: 'synthetic-loader',
      navigationType: 'differentDocument',
    },
  ],
  [
    'Page.navigatedWithinDocument',
    { frameId: 'named-unsafe', url: '://', navigationType: 'fragment' },
  ],
  [
    'Page.frameRequestedNavigation',
    {
      frameId: 'named-unsafe',
      url: 'synthetic-unsafe-event',
      reason: 'scriptInitiated',
      disposition: 'currentTab',
    },
  ],
  [
    'Page.javascriptDialogOpening',
    {
      frameId: 'named-unsafe',
      url: 'chrome-error://chromewebdata/',
      message: 'synthetic-unsafe-event',
      type: 'alert',
      hasBrowserHandler: true,
    },
  ],
  [
    'Page.windowOpen',
    {
      frameId: 'named-unsafe',
      url: 'synthetic-unsafe-event',
      windowName: '',
      windowFeatures: [],
      userGesture: false,
    },
  ],
  ['Page.frameAttached', { frameId: 'named-safe', parentFrameId: 'named-unsafe' }],
  [
    'Runtime.executionContextCreated',
    {
      context: {
        id: 991,
        origin: '://',
        name: 'synthetic-unsafe-event',
        auxData: { isDefault: true, type: 'default', frameId: 'named-unsafe' },
      },
    },
  ],
]) {
  test(`state named event ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('named-owner');
    const session = await wire.attach('named-owner');
    await wire.send('Page.enable', {}, session);
    await wire.send('Runtime.enable', {}, session);
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-named-owner',
      params: { frame: { ...errorFrame('named-unsafe', 'named-owner'), unreachableUrl: '://' } },
    });
    await flush();
    const mark = wire.delivered.length;
    wire.emit({ method, sessionId: session, params });
    await flush();
    if (method === 'Page.frameAttached') {
      const metadata = wire.delivered.slice(mark).find((message) => message.method === method);
      assert.ok(metadata);
      assert.deepEqual(metadata.params, { frameId: 'named-safe', parentFrameId: 'named-unsafe' });
    } else
      assert.equal(
        wire.delivered.slice(mark).some((message) => message.method === method),
        false
      );
    assert.equal(
      JSON.stringify(wire.delivered.slice(mark)).includes('synthetic-unsafe-event'),
      false
    );
  });
}
