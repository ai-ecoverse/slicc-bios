import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INHERITED, PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protectedOrigin,
  protocol,
} from './guard-state-fixture.mjs';

for (const method of [
  'Page.frameNavigated',
  'Page.frameAttached',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
  'Page.frameDetached',
]) {
  test(`state main protected naming precedes lifecycle ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('parity-owner');
    const session = await wire.attach('parity-owner');
    await wire.send('Page.enable', {}, session);
    const frame = errorFrame('parity-child', 'parity-owner');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-parity-owner',
      params: { frame },
    });
    await flush();
    const mark = wire.delivered.length;
    const params =
      method === 'Page.frameNavigated'
        ? { frame }
        : { frameId: frame.id, url: failed, reason: 'swap' };
    wire.emit({ method, sessionId: session, params });
    await flush();
    assert.equal(
      wire.delivered.slice(mark).some((event) => event.method === method),
      false
    );
    assert.equal(JSON.stringify(wire.delivered.slice(mark)).includes(protectedOrigin), false);
  });
}

test('state lifecycle respects the caller Page enable state', async (t) => {
  const wire = protocol(t);
  wire.target('parity-page-enable');
  const session = await wire.attach('parity-page-enable');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-page-enable',
    params: { frame: errorFrame('parity-page-child', 'parity-page-enable') },
  });
  await flush();
  const mark = wire.delivered.length;
  const event = {
    method: 'Page.frameStartedLoading',
    sessionId: session,
    params: { frameId: 'parity-page-child', extra: 'synthetic-page-private' },
  };
  wire.emit(event);
  await flush();
  assert.equal(
    wire.delivered.slice(mark).some((reply) => reply.method === event.method),
    false
  );
  await wire.send('Page.enable', {}, session);
  wire.emit(event);
  await flush();
  const shown = wire.delivered.slice(mark).find((reply) => reply.method === event.method);
  assert.ok(shown);
  assert.deepEqual(shown.params, { frameId: 'parity-page-child' });
});

for (const method of [
  'Target.targetCreated',
  'Target.targetInfoChanged',
  'Target.getTargets',
  'Target.getTargetInfo',
]) {
  test(`state protected error metadata has no protected origin ${method}`, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('parity-target');
    const session = await wire.attach('parity-target');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-parity-target',
      params: { frame: errorFrame('parity-target') },
    });
    await flush();
    entry.info.url = 'chrome-error://chromewebdata/';
    entry.info.title = failed;
    const mark = wire.delivered.length;
    let info;
    if (method.startsWith('Target.get')) {
      const reply = await wire.send(method, { targetId: 'parity-target' });
      assert.equal(reply.error, undefined);
      info = reply.result.targetInfo ?? reply.result.targetInfos[0];
    } else {
      wire.emit({ method, sessionId: session, params: { targetInfo: entry.info } });
      await flush();
      info = wire.delivered.slice(mark).find((event) => event.method === method)?.params.targetInfo;
    }
    assert.ok(info);
    assert.equal(info.url, 'chrome-error://chromewebdata/');
    assert.equal(info.title, 'chrome-error://chromewebdata/');
    assert.equal(JSON.stringify(wire.delivered.slice(mark)).includes(protectedOrigin), false);
  });
}

test('state protected error refuses reads without changing the about navigation refusal', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('parity-refusal');
  const session = await wire.attach('parity-refusal');
  entry.tree.frame = errorFrame('parity-refusal');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-refusal',
    params: { frame: entry.tree.frame },
  });
  await flush();
  for (const method of [
    'Runtime.evaluate',
    'DOM.getDocument',
    'Accessibility.getFullAXTree',
    'Page.captureScreenshot',
  ])
    assert.equal((await wire.send(method, {}, session)).error?.message, PROTECTED);
  assert.equal(
    (await wire.send('Page.navigate', { url: 'about:blank' }, session)).error?.message,
    INHERITED
  );
  assert.equal(
    (await wire.send('Page.navigate', { url: ' about:blank' }, session)).error?.message,
    INHERITED
  );
  entry.tree.frame = plainFrame('parity-refusal');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-refusal',
    params: { frame: entry.tree.frame },
  });
  await flush();
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error, undefined);
});

test('state an unsafe receipt cannot revive when redaction changes its envelope', async (t) => {
  const wire = protocol(t);
  wire.target('parity-receipt');
  const session = await wire.attach('parity-receipt');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-receipt',
    params: { frame: errorFrame('parity-receipt-child', 'parity-receipt') },
  });
  await flush();
  const mark = wire.delivered.length;
  const event = {
    method: 'Log.entryAdded',
    sessionId: session,
    params: { entry: { source: 'javascript', level: 'info', text: failed, timestamp: 1 } },
  };
  wire.emit(event);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-receipt',
    params: { frame: plainFrame('parity-receipt-child', 'parity-receipt') },
  });
  await flush();
  assert.equal(
    wire.delivered.slice(mark).some((reply) => reply.method === event.method),
    false
  );
  wire.emit({ ...event, params: { entry: { ...event.params.entry, text: ordinary } } });
  await flush();
  assert.ok(wire.delivered.slice(mark).some((reply) => reply.method === event.method));
});

test('state registration filtering retains an unsafe receipt until publication', async (t) => {
  const wire = protocol(t);
  wire.target('parity-registration');
  const session = await wire.attach('parity-registration');
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-registration',
    params: { frame: errorFrame('parity-registration') },
  });
  await flush();
  const mark = wire.delivered.length;
  const event = {
    method: 'ServiceWorker.workerRegistrationUpdated',
    sessionId: session,
    params: {
      registrations: [
        { registrationId: 'ordinary-registration', scopeURL: ordinary, isDeleted: false },
      ],
    },
  };
  wire.emit(event);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-registration',
    params: { frame: plainFrame('parity-registration') },
  });
  await flush();
  assert.equal(
    wire.delivered.slice(mark).some((reply) => reply.method === event.method),
    false
  );
  wire.emit(event);
  await flush();
  assert.ok(wire.delivered.slice(mark).some((reply) => reply.method === event.method));
});

test('state synthesized network metadata retains the original receipt', async (t) => {
  const wire = protocol(t);
  wire.target('parity-network');
  const session = await wire.attach('parity-network');
  const params = {
    requestId: 'parity-network-request',
    frameId: 'parity-network',
    type: 'Document',
    request: { url: ordinary },
  };
  wire.emit({ method: 'Network.requestWillBeSent', sessionId: session, params });
  await flush();
  wire.emit({
    method: 'Network.requestWillBeSent',
    sessionId: session,
    params: {
      ...params,
      request: { url: failed },
      redirectResponse: { url: ordinary, status: 302 },
    },
  });
  await flush();
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-network',
    params: { frame: errorFrame('parity-network') },
  });
  await flush();
  const mark = wire.delivered.length;
  const event = {
    method: 'Network.loadingFinished',
    sessionId: session,
    params: { requestId: params.requestId, timestamp: 1 },
  };
  wire.emit(event);
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-parity-network',
    params: { frame: plainFrame('parity-network') },
  });
  await flush();
  assert.equal(
    wire.delivered.slice(mark).some((reply) => reply.method.startsWith('Network.')),
    false
  );
  wire.emit(event);
  await flush();
  assert.ok(wire.delivered.slice(mark).some((reply) => reply.method === 'Network.loadingFailed'));
});
