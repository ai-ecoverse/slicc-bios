import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorFrame, failed, flush, plainFrame, protocol } from './guard-state-fixture.mjs';

const opaque = Buffer.from(failed).toString('base64');

for (const failure of [
  { error: { code: -32000, message: 'synthetic unavailable iframe tree' } },
  { result: {} },
]) {
  test(`state parented proof ${failure.error ? 'error' : 'missing'}`, {
    timeout: 5000,
  }, async (t) => {
    const wire = protocol(t);
    wire.target('parent', 'page', plainFrame('physical-parent'));
    await wire.attach('parent');
    const entry = wire.target(
      'child-target',
      'iframe',
      plainFrame('physical-child', 'physical-parent')
    );
    wire.hold(
      (m) =>
        m.id < 2 ** 30 &&
        m.method === 'Target.attachToTarget' &&
        m.params.targetId === 'child-target'
    );
    const attaching = wire.request('Target.attachToTarget', {
      targetId: 'child-target',
      flatten: true,
    });
    await flush();
    const attachment = wire.held.find((m) => m.id === attaching.id);
    assert.ok(attachment);
    entry.tree = { frame: errorFrame('physical-child', 'physical-parent') };
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: 'guard-child-target',
      params: { frame: entry.tree.frame },
    });
    wire.hold(
      (m) =>
        m.id >= 2 ** 30 && m.method === 'Page.getFrameTree' && m.sessionId === 'client-child-target'
    );
    wire.release(attachment);
    await flush();
    const proof = wire.held.find((m) => m.method === 'Page.getFrameTree');
    assert.ok(proof);
    wire.release(proof, failure);
    const answer = await attaching.answer;
    const session = answer.result?.sessionId ?? 'client-child-target';
    wire.hold((m) => m.id < 2 ** 30 && m.method === 'Runtime.evaluate');
    const mark = wire.sent.length;
    const read = wire.request(
      'Runtime.evaluate',
      { expression: "btoa(loadTimeData.getString('failedUrl'))" },
      session
    );
    await flush();
    const pending = wire.held.find((m) => m.id === read.id);
    if (pending) wire.release(pending, { result: { result: { type: 'string', value: opaque } } });
    const content = await read.answer;
    await wire.send('Log.enable', {}, session);
    const eventMark = wire.delivered.length;
    wire.emit({
      method: 'Log.entryAdded',
      sessionId: session,
      params: {
        entry: {
          source: 'javascript',
          level: 'error',
          text: opaque,
          timestamp: 1,
          url: 'chrome-error://chromewebdata/',
        },
      },
    });
    await flush();
    assert.deepEqual(
      {
        attachRefused: /^slicc: refused:/.test(answer.error?.message ?? ''),
        forwarded: wire.clients(mark).some((m) => m.method === 'Runtime.evaluate'),
        contentRefused: /^slicc: refused:/.test(content.error?.message ?? ''),
        contentPublished: JSON.stringify(content).includes(opaque),
        eventPublished: JSON.stringify(wire.delivered.slice(eventMark)).includes(opaque),
      },
      {
        attachRefused: true,
        forwarded: false,
        contentRefused: true,
        contentPublished: false,
        eventPublished: false,
      },
      'a root can carry parentId and still belong to its observed iframe target'
    );
  });
}

for (const source of ['private-guard-tree', 'guard-frame-commit']) {
  test(`state parented ordinary ${source}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    wire.target('parent', 'page', plainFrame('physical-parent'));
    await wire.attach('parent');
    const entry = wire.target(
      'child-target',
      'iframe',
      plainFrame('physical-child', 'physical-parent')
    );
    const child = await wire.attach('child-target');
    if (source === 'guard-frame-commit')
      wire.emit({
        method: 'Page.frameNavigated',
        sessionId: 'guard-child-target',
        params: { frame: entry.tree.frame },
      });
    assert.equal(
      (await wire.send('Runtime.evaluate', { expression: '1' }, child)).error,
      undefined
    );
  });
}
