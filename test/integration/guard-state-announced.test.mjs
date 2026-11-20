import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorFrame,
  failed,
  flush,
  plainFrame,
  protocol,
  rejectingTree,
} from './guard-state-fixture.mjs';

test('showAttachment stranded reject: page announced at most once, session cut', async (t) => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
    origWarn(...args);
  };
  t.after(() => {
    console.warn = origWarn;
  });

  const wire = protocol(t);
  const entry = wire.target('host', 'page', plainFrame('host'));
  let arm = false;

  wire.hold((message) => {
    if (message.method !== 'Page.getFrameTree') return false;
    if (!entry.info.url?.includes('protected.invalid')) return false;
    const stack = new Error().stack ?? '';
    queueMicrotask(() => {
      const frame = errorFrame('host');
      entry.tree = { frame };
      if (arm && message.sessionId === 'guard-host' && stack.includes('showAttachment')) {
        wire.release(message, { result: rejectingTree(frame) }, true);
        return;
      }
      wire.release(message, { result: { frameTree: { frame } } });
    });
    return true;
  });

  await wire.attach('host');
  await flush();
  entry.tree = { frame: errorFrame('host') };
  entry.info.url = `${failed}?private=query#fragment`;
  entry.info.title = 'private';
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-host',
    params: { frame: errorFrame('host') },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 150));

  arm = true;
  const before = wire.delivered.length;
  const session = 'client-host-2';
  wire.attached('host', undefined, session);
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 100));
  wire.attached('host', undefined, session);
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const shown = wire.delivered
    .slice(before)
    .filter(
      (message) =>
        message.method === 'Target.attachedToTarget' && message.params?.sessionId === session
    );
  assert.ok(shown.length <= 1, `page announced ${shown.length} times`);

  const cut = wire.delivered
    .slice(before)
    .some(
      (message) =>
        (message.method === 'Target.detachedFromTarget' && message.params?.sessionId === session) ||
        (message.method === 'Target.targetDestroyed' && message.params?.targetId === 'host')
    );
  const detached = wire.sent.some(
    (message) =>
      message.method === 'Target.detachFromTarget' && message.params?.sessionId === session
  );
  assert.ok(cut || detached, 'session must end withdrawn or cut, not flagged-but-never-announced');
  assert.ok(
    warnings.some(
      (line) => line.includes('dropped a message') && line.includes('stranded rejected')
    ),
    'showAttachment stranded() must reject'
  );
});
