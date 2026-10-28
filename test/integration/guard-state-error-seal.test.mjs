import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import {
  errorFrame,
  failed,
  flush,
  ordinary,
  plainFrame,
  protocol,
} from './guard-state-fixture.mjs';

async function sealed(t, change = () => {}, denyAttach = false) {
  const wire = protocol(t);
  const entry = wire.target('sealed-root');
  if (denyAttach)
    wire.hold((message) => {
      if (message.method !== 'Target.setAutoAttach') return false;
      queueMicrotask(() => wire.release(message, { error: { code: -32000, message: PROTECTED } }));
      return true;
    });
  const session = await wire.attach('sealed-root');
  wire.hold((message) => {
    if (
      message.sessionId !== 'guard-sealed-root' ||
      !['DOM.getDocument', 'DOM.disable', ...(denyAttach ? ['Target.setAutoAttach'] : [])].includes(
        message.method
      )
    )
      return false;
    queueMicrotask(() => wire.release(message, { error: { code: -32000, message: PROTECTED } }));
    return true;
  });
  entry.tree.frame = { ...errorFrame('sealed-root'), loaderId: 'sealed-error-loader' };
  entry.info.url = failed;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-sealed-root',
    params: { frame: entry.tree.frame },
  });
  change(wire, entry);
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  return { wire, entry, session };
}

test('sealed error root recovers through guardian evidence without opening document commands', async (t) => {
  const { wire, session } = await sealed(t);
  for (const method of ['Runtime.evaluate', 'DOM.getDocument', 'Page.captureScreenshot'])
    assert.equal((await wire.send(method, {}, session)).error?.message, PROTECTED);
  const answer = await wire.send('Target.attachToTarget', {
    targetId: 'sealed-root',
    flatten: true,
  });
  assert.equal(answer.error, undefined);
  assert.equal((await wire.send('Page.navigate', { url: ordinary }, session)).error, undefined);
});

for (const boundary of ['frame', 'target', 'remote owner', 'Page.enable']) {
  test(`sealed error root keeps its ${boundary} boundary closed`, async (t) => {
    const { wire, session } = await sealed(t, (wire, entry) => {
      if (boundary === 'frame')
        entry.tree.childFrames = [{ frame: plainFrame('sealed-child', 'sealed-root') }];
      if (boundary === 'target') {
        const child = wire.target('sealed-child', 'iframe', plainFrame('sealed-child'));
        child.info.parentId = 'sealed-root';
        wire.emit({ method: 'Target.targetCreated', params: { targetInfo: child.info } });
      }
      if (boundary === 'remote owner')
        wire.emit({
          method: 'Page.frameAttached',
          sessionId: 'guard-sealed-root',
          params: { frameId: 'sealed-remote', parentFrameId: 'sealed-root' },
        });
      if (boundary === 'Page.enable')
        wire.hold((message) => {
          if (
            message.sessionId !== 'guard-sealed-root' ||
            !['DOM.getDocument', 'DOM.disable', 'Page.enable'].includes(message.method)
          )
            return false;
          queueMicrotask(() =>
            wire.release(message, { error: { code: -32000, message: PROTECTED } })
          );
          return true;
        });
    });
    assert.equal((await wire.send('Page.reload', {}, session)).error?.message, PROTECTED);
    assert.equal(
      (await wire.send('Target.attachToTarget', { targetId: 'sealed-root', flatten: true })).error
        ?.message,
      PROTECTED
    );
  });
}

test('sealed error root does not excuse failed descendant discovery', async (t) => {
  const { wire, session } = await sealed(t, () => {}, true);
  assert.equal((await wire.send('Page.reload', {}, session)).error?.message, PROTECTED);
});

test('sealed ordinary document still requires a ready placement for page content', async (t) => {
  const { wire, entry, session } = await sealed(t);
  entry.tree.frame = plainFrame('sealed-root');
  entry.info.url = ordinary;
  wire.emit({
    method: 'Page.frameNavigated',
    sessionId: 'guard-sealed-root',
    params: { frame: entry.tree.frame },
  });
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  assert.equal((await wire.send('DOM.getDocument', {}, session)).error?.message, PROTECTED);
  assert.equal((await wire.send('Page.captureScreenshot', {}, session)).error?.message, PROTECTED);
});

test('recovery navigation uses its own proof while a client hint check is in flight', async (t) => {
  const wire = protocol(t);
  const entry = wire.target('hint-exit');
  const session = await wire.attach('hint-exit');
  t.after(() => {
    wire.hold(() => false);
    for (const message of [...wire.held]) wire.release(message);
  });
  wire.hold((message) => message.method === 'Page.getFrameTree' && message.sessionId === session);
  entry.info.url = failed;
  wire.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: entry.info } });
  await flush();
  assert.ok(wire.held.some((message) => message.sessionId === session));
  assert.equal((await wire.send('Runtime.evaluate', {}, session)).error?.message, PROTECTED);
  const attempt = wire.request('Page.navigate', { url: ordinary }, session);
  await flush();
  assert.ok(wire.clients().some((message) => message.id === attempt.id));
  wire.hold(() => false);
  for (const message of [...wire.held]) wire.release(message);
  assert.equal((await attempt.answer).error, undefined);
});
