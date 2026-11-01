import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

for (const route of [
  { kind: 'extension', version: '7.10.1' },
  { kind: 'link', version: '1.49.37' },
]) {
  test(`${route.kind}: a clean root reload holds its first pause for existing placement, not a private snapshot`, async (t) => {
    let reads = 0;
    let loader = 'old-loader';
    const p = protocol(t, (raw, own) =>
      guardProtected(raw, own, new Map(), route, async () => {
        reads++;
        return {
          version: 1,
          revision: 0,
          rootFrameId: 'root',
          rootLoaderId: loader,
          rootDocumentId: 'root-native-document',
          remoteOwners: [],
          frames: [
            {
              frameId: 0,
              parentFrameId: -1,
              documentId: 'root-native-document',
              url: 'https://ordinary.invalid/page',
            },
          ],
        };
      })
    );
    const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'old-loader' });
    const session = await p.attach('root');
    assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
    loader = 'new-loader';
    root.tree.frame.loaderId = loader;
    p.hold(({ method, id }) => method === 'Page.getFrameTree' && id >= 2 ** 30);
    p.emit({
      sessionId: session,
      method: 'Page.frameNavigated',
      params: { frame: root.tree.frame },
    });
    await flush();
    const since = p.sent.length;
    p.emit({
      sessionId: session,
      method: 'Debugger.paused',
      params: {
        reason: 'other',
        callFrames: [{ callFrameId: 'frame', location: { scriptId: 'script' } }],
      },
    });
    await flush();
    assert.equal(
      p.sent.slice(since).some(({ method }) => method === 'Debugger.resume'),
      false
    );
    assert.equal(
      p.delivered.some(({ method }) => method === 'Debugger.paused'),
      false
    );
    p.hold(() => false);
    for (const message of [...p.held]) p.release(message);
    await flush();
    await flush();
    assert.equal(p.delivered.filter(({ method }) => method === 'Debugger.paused').length, 1);
    assert.equal(
      (
        await p.send(
          'Debugger.setInstrumentationBreakpoint',
          { instrumentation: 'beforeScriptExecution' },
          session
        )
      ).error,
      undefined
    );
    assert.equal(reads, 0, 'a root without remote owners needs no native snapshot');
  });

  test(`${route.kind}: a clean protected root reload privately resumes after placement and publishes nothing`, async (t) => {
    const p = protocol(t, (raw, own) =>
      guardProtected(raw, own, new Map(), route, async () => null)
    );
    const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'old-loader' });
    const session = await p.attach('root');
    assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
    root.tree.frame = {
      id: 'root',
      loaderId: 'protected-loader',
      url: 'https://protected.invalid/private',
      securityOrigin: 'https://protected.invalid',
    };
    p.emit({
      sessionId: session,
      method: 'Page.frameNavigated',
      params: { frame: root.tree.frame },
    });
    const since = p.sent.length;
    p.emit({
      sessionId: session,
      method: 'Debugger.paused',
      params: { reason: 'other', callFrames: [] },
    });
    await flush();
    await flush();
    assert.ok(
      p.sent
        .slice(since)
        .some(
          ({ id, method, sessionId: owner }) =>
            id >= 2 ** 30 && method === 'Debugger.resume' && owner === session
        )
    );
    assert.equal(
      p.delivered.some(({ method }) => method === 'Debugger.paused'),
      false
    );
    assert.match(
      (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
      /^slicc: refused:/
    );
    assert.doesNotMatch(JSON.stringify(p.delivered), /protected\.invalid/);
  });
}
