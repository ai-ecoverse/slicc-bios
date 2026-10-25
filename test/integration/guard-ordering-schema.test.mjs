import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-ordering-fixture.mjs';

const uncertain = [
  (id) => ({ frame: { id, url: '', securityOrigin: '://' } }),
  (id) => ({ frame: { id, securityOrigin: '://' } }),
  (id) => ({ frame: { id, url: '://', securityOrigin: '://' } }),
  (id) => ({ frame: { id, url: 'null', securityOrigin: '://' } }),
  () => ({ frame: { url: ordinary, securityOrigin: '://' } }),
  () => ({ frame: { id: 0, url: ordinary, securityOrigin: '://' } }),
  (id) => ({ frame: { id, url: ordinary, securityOrigin: {} } }),
  (id) => ({ frame: { id, url: ordinary, unreachableUrl: {} } }),
  (id) => ({ frame: plainFrame(id), childFrames: [{}] }),
  (id) => ({
    frame: plainFrame(id),
    childFrames: [{ frame: { id: 'unknown-child', parentId: id, url: '', securityOrigin: '://' } }],
  }),
  (id) => ({ frame: plainFrame(id), childFrames: [{ frame: plainFrame(id, id) }] }),
];

for (const [index, tree] of uncertain.entries()) {
  test(`ordering uncertain tree ${index}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('schema');
    const session = await wire.attach('schema');
    const frame = errorFrame('schema');
    entry.tree = { frame };
    wire.hold(
      (message) => message.method === 'Page.getFrameTree' && message.sessionId === 'guard-schema'
    );
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame, type: 'BackForwardCacheRestore' },
    });
    const mark = wire.sent.length;
    const read = wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    await flush();
    const probe = wire.held.find((message) => message.method === 'Page.getFrameTree');
    assert.ok(probe);
    wire.release(probe, { result: { frameTree: tree('schema') } });
    const answer = await read;
    const forwarded = wire.clients(mark);
    wire.hold(() => false);
    entry.tree = { frame: plainFrame('schema') };
    const recovery = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    assert.deepEqual(forwarded, [], 'unclassified evidence never forwards content');
    assert.match(answer.error?.message ?? '', /^slicc: refused:/);
    assert.equal(answer.result, undefined);
    assert.equal(JSON.stringify(wire.delivered).includes(failed), false);
    assert.equal(recovery.error, undefined);
    assert.equal(recovery.result?.result?.value, 'synthetic-content');
    assert.equal(
      wire.sent.some((message) => message.method === 'Target.detachFromTarget'),
      false
    );
  });
}

const known = [
  ['ordinary', ordinary, new URL(ordinary).origin],
  ['data', 'data:text/html,ordinary', 'null'],
  ['blank', 'about:blank', new URL(ordinary).origin],
  ['opaque-blank', 'about:blank', '://'],
  ['srcdoc', 'about:srcdoc', new URL(ordinary).origin],
  ['blob', 'blob:https://ordinary.invalid/synthetic', new URL(ordinary).origin],
  ['newtab', 'chrome://newtab/', 'chrome://newtab'],
];
for (const [kind, url, securityOrigin] of known) {
  test(`ordering known tree ${kind}`, { timeout: 5000 }, async (t) => {
    const wire = protocol(t);
    const entry = wire.target('schema');
    const session = await wire.attach('schema');
    entry.tree = { frame: { id: 'schema', url, securityOrigin } };
    const read = await wire.send('Runtime.evaluate', { expression: 'document.title' }, session);
    assert.equal(read.error, undefined);
    assert.equal(read.result?.result?.value, 'synthetic-content');
  });
}
