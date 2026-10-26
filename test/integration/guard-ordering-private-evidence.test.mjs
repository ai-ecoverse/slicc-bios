import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, ordinary, protocol } from './guard-ordering-fixture.mjs';

const read = (wire, session) =>
  wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
const refused = (answer) => {
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
};
const context = (wire, session) =>
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 93,
        uniqueId: 'synthetic-private-evidence',
        origin: new URL(ordinary).origin,
        name: '',
        auxData: { frameId: 'owner', isDefault: true, type: 'default' },
      },
    },
  });

for (const outcome of ['protected', 'error-document', 'error', 'missing']) {
  test(`ordering private context evidence closes its owner ${outcome}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('owner');
    const session = await wire.attach('owner');
    await wire.send('Runtime.enable', {}, session);
    await read(wire, session);
    wire.hold(
      (message) =>
        message.id >= 2 ** 30 &&
        message.method === 'Runtime.evaluate' &&
        message.params.expression === 'location.href'
    );
    context(wire, session);
    await flush();
    const held = wire.held.find((message) => message.method === 'Runtime.evaluate');
    assert.ok(held);
    wire.release(
      held,
      outcome === 'error'
        ? { error: { code: -32000, message: 'synthetic realm uncertainty' } }
        : outcome === 'missing'
          ? { result: {} }
          : {
              result: {
                result: {
                  value: outcome === 'protected' ? failed : 'chrome-error://chromewebdata/',
                },
              },
            }
    );
    await flush();
    assert.equal(
      wire.delivered.some((message) => message.method === 'Runtime.executionContextCreated'),
      false
    );
    wire.privateFailure(true);
    const mark = wire.sent.length;
    refused(await read(wire, session));
    assert.deepEqual(wire.clients(mark), [], 'negative private evidence is a target-scope veto');
    wire.privateFailure(false);
    wire.hold(() => false);
    assert.equal(
      (await read(wire, session)).error,
      undefined,
      'new harmless requests may recover through a new independent tree'
    );
  });
}

test('ordering a failed private tree cannot revive an older answer after positive recovery', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  wire.target('owner');
  const session = await wire.attach('owner');
  await wire.send('Runtime.enable', {}, session);
  await read(wire, session);
  wire.hold(
    (message) =>
      (message.id < 2 ** 30 && message.method === 'Page.captureScreenshot') ||
      (message.id >= 2 ** 30 && ['Runtime.evaluate', 'Page.getFrameTree'].includes(message.method))
  );
  const shot = wire.request('Page.captureScreenshot', {}, session);
  await flush();
  const pending = wire.held.find((message) => message.id === shot.id);
  assert.ok(pending);
  context(wire, session);
  await flush();
  wire.release(
    wire.held.find((message) => message.id >= 2 ** 30 && message.method === 'Runtime.evaluate'),
    { result: { result: { value: `${ordinary}/different` } } }
  );
  await flush();
  wire.release(
    wire.held.find((message) => message.id >= 2 ** 30 && message.method === 'Page.getFrameTree'),
    { error: { code: -32000, message: 'synthetic current tree uncertainty' } }
  );
  await flush();
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
  assert.equal((await read(wire, session)).error, undefined);
  wire.release(pending, { result: { data: 'synthetic-old-answer' } });
  refused(await shot.answer);
});

for (const method of ['Target.targetCreated', 'Target.getTargets']) {
  test(`ordering never-attached metadata withholds an unclassified title ${method}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('unclassified', 'page', errorFrame('unclassified'));
    entry.info.url = ordinary;
    entry.info.title = 'synthetic-unclassified-title';
    wire.privateFailure(true);
    if (method === 'Target.targetCreated') {
      wire.emit({ method, params: { targetInfo: entry.info } });
      await flush();
    } else {
      wire.hold((message) => message.id < 2 ** 30 && message.method === method);
      const request = wire.request(method);
      await flush();
      wire.release(
        wire.held.find((message) => message.id === request.id),
        { result: { targetInfos: [entry.info] } }
      );
      await request.answer;
    }
    assert.equal(JSON.stringify(wire.delivered).includes(entry.info.title), false);
  });
}

test('ordering transport error-document evidence closes commands before its private lookup completes', {
  timeout: 5000,
}, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('owner');
  wire.target('unknown-frame', 'iframe');
  const session = await wire.attach('owner');
  await read(wire, session);
  wire.hold(
    (message) =>
      (message.id < 2 ** 30 && message.method === 'Page.captureScreenshot') ||
      (message.id >= 2 ** 30 &&
        message.method === 'Target.getTargetInfo' &&
        message.params.targetId === 'unknown-frame')
  );
  const shot = wire.request('Page.captureScreenshot', {}, session);
  await flush();
  const pending = wire.held.find((message) => message.id === shot.id);
  assert.ok(pending);
  entry.tree = { frame: errorFrame('owner') };
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      requestId: 'unplaced-transport',
      type: 'Other',
      frameId: 'unknown-frame',
      documentURL: 'chrome-error://chromewebdata/',
      request: { url: ordinary, postData: 'synthetic-unclassified-transport' },
    },
  });
  await flush();
  const lookup = wire.held.find((message) => message.method === 'Target.getTargetInfo');
  assert.ok(lookup);
  const mark = wire.sent.length;
  const command = read(wire, session);
  await flush();
  const forwarded = wire.clients(mark);
  wire.hold(() => false);
  wire.release(lookup, { error: { code: -32000, message: 'synthetic unplaced frame failure' } });
  wire.release(pending);
  refused(await shot.answer);
  await command;
  assert.deepEqual(
    forwarded,
    [],
    'structured error evidence latches before the private ownership read settles'
  );
});
