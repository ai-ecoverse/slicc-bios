import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

for (const method of [
  'Runtime.evaluate',
  'DOMSnapshot.captureSnapshot',
  'Page.captureScreenshot',
]) {
  test(`state unsafe issue ${method}`, async (t) => {
    const wire = protocol(t);
    wire.target('unsafe-issue');
    const session = await wire.attach('unsafe-issue');
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-unsafe-issue',
      params: { frame: errorFrame('unsafe-issue') },
    });
    wire.hold((message) => message.id < 2 ** 30 && message.method === method);
    const mark = wire.sent.length;
    const read = wire.request(
      method,
      method === 'Runtime.evaluate' ? { expression: '1' } : {},
      session
    );
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-unsafe-issue',
      params: { frame: plainFrame('unsafe-issue') },
    });
    await flush();
    const held = wire.held.find((message) => message.id === read.id);
    if (held) wire.release(held);
    const answer = await read.answer;
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.deepEqual(
      wire.clients(mark).filter((message) => message.id === read.id),
      []
    );
    wire.hold(() => false);
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, session)).error,
      undefined
    );
  });
}

test('state retained queued reply', async (t) => {
  const wire = protocol(t);
  wire.target('queued-reply');
  const session = await wire.attach('queued-reply');
  wire.hold((message) => message.id < 2 ** 30 && message.method === 'Page.captureScreenshot');
  const read = wire.request('Page.captureScreenshot', {}, session);
  await flush();
  const held = wire.held.find((message) => message.id === read.id);
  wire.release(held, { result: { data: 'synthetic-queued-reply' } });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-queued-reply',
    params: { frame: errorFrame('queued-reply') },
  });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-queued-reply',
    params: { frame: plainFrame('queued-reply') },
  });
  const answer = await read.answer;
  assert.match(answer.error?.message ?? '', /^slicc: refused:/);
  assert.equal(answer.result, undefined);
});

const opaque = Buffer.from(failed).toString('base64');

for (const method of [
  'Page.captureScreenshot',
  'Runtime.evaluate',
  'DOMSnapshot.captureSnapshot',
]) {
  test(`state retained ${method}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('live');
    const session = await wire.attach('live');
    wire.hold((m) => m.id < 2 ** 30 && m.method === method);
    const request = wire.request(
      method,
      method === 'Runtime.evaluate'
        ? { expression: "btoa(loadTimeData.getString('failedUrl'))" }
        : method === 'DOMSnapshot.captureSnapshot'
          ? { computedStyles: [] }
          : {},
      session
    );
    await flush();
    const pending = wire.held.find((m) => m.id === request.id);
    assert.ok(pending);
    entry.tree = { frame: errorFrame('live') };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-live',
      params: { frame: entry.tree.frame },
    });
    entry.tree = { frame: plainFrame('live') };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-live',
      params: { frame: entry.tree.frame },
    });
    wire.release(pending, {
      result:
        method === 'Runtime.evaluate'
          ? { result: { type: 'string', value: opaque } }
          : method === 'DOMSnapshot.captureSnapshot'
            ? { documents: [], strings: [opaque] }
            : { data: opaque },
    });
    const answer = await request.answer;
    assert.deepEqual(
      {
        refused: /^slicc: refused:/.test(answer.error?.message ?? ''),
        exposed: JSON.stringify(answer).includes(opaque),
      },
      { refused: true, exposed: false },
      'safe current state does not authorize an older crossing read'
    );
  });
}

test('state retained receipt', { timeout: 5000 }, async (t) => {
  const wire = protocol(t);
  const entry = wire.target('live');
  const session = await wire.attach('live');
  await wire.send('Runtime.enable', {}, session);
  const mark = wire.delivered.length;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: errorFrame('live') },
  });
  wire.emit({
    method: 'Runtime.executionContextCreated',
    sessionId: session,
    params: {
      context: {
        id: 71,
        origin: 'chrome-error://chromewebdata/',
        name: '',
        auxData: { frameId: 'live', isDefault: true, type: 'default' },
      },
    },
  });
  wire.emit({
    method: 'Runtime.consoleAPICalled',
    sessionId: session,
    params: {
      type: 'log',
      executionContextId: 71,
      args: [{ type: 'string', value: opaque }],
      timestamp: 1,
    },
  });
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-live',
    params: { frame: plainFrame('live') },
  });
  await flush();
  assert.equal(
    JSON.stringify(wire.delivered.slice(mark)).includes(opaque),
    false,
    'publication was received from a known protected error document'
  );
});

for (const missing of [
  { error: { code: -32000, message: 'synthetic unavailable tree' } },
  { result: {} },
]) {
  test(`state retained owner ${missing.error ? 'error' : 'missing'}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('target', 'page', plainFrame('physical-root'));
    wire.hold((m) => m.id < 2 ** 30 && m.method === 'Target.attachToTarget');
    const attaching = wire.request('Target.attachToTarget', { targetId: 'target', flatten: true });
    await flush();
    const attachment = wire.held.find((m) => m.id === attaching.id);
    assert.ok(attachment);
    entry.tree = { frame: errorFrame('physical-root') };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-target',
      params: { frame: entry.tree.frame },
    });
    wire.hold((m) => m.id >= 2 ** 30 && m.method === 'Page.getFrameTree');
    wire.release(attachment);
    await flush();
    const proof = wire.held.find((m) => m.method === 'Page.getFrameTree');
    assert.ok(proof);
    wire.release(proof, missing);
    const answer = await attaching.answer;
    const session = answer.result?.sessionId ?? 'client-target';
    const mark = wire.sent.length;
    const content = await wire.send(
      'Runtime.evaluate',
      { expression: "btoa(loadTimeData.getString('failedUrl'))" },
      session
    );
    assert.deepEqual(
      {
        attachRefused: /^slicc: refused:/.test(answer.error?.message ?? ''),
        forwarded: wire.clients(mark).some((m) => m.method === 'Runtime.evaluate'),
        contentRefused: /^slicc: refused:/.test(content.error?.message ?? ''),
      },
      { attachRefused: true, forwarded: false, contentRefused: true },
      'known guard-session error state survives a failed client proof'
    );
  });
}
