import assert from 'node:assert/strict';
import test from 'node:test';
import { guardProtected } from '../../src/seed/guard.js';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

test('a Debugger reply sent before suspension is refused rather than published during re-placement', async (t) => {
  let list = {
    version: 1,
    revision: 0,
    rootDocumentId: 'native',
    rootFrameId: 'root',
    rootLoaderId: 'loader',
    remoteOwners: [],
    frames: [
      { frameId: 0, parentFrameId: -1, documentId: 'native', url: 'https://ordinary.invalid/page' },
    ],
  };
  const p = protocol(t, (raw, own) =>
    guardProtected(raw, own, new Map(), { kind: 'extension', version: '7.11.1' }, async () => list)
  );
  p.target('root', 'page', { ...plainFrame('root'), loaderId: 'loader' });
  const session = await p.attach('root');
  assert.equal((await p.send('Debugger.enable', {}, session)).error, undefined);
  p.hold((message) => message.id < 2 ** 30 && message.method === 'Debugger.removeBreakpoint');
  const request = p.request('Debugger.removeBreakpoint', { breakpointId: 'owned' }, session);
  await flush();
  list = null;
  p.emit({
    sessionId: session,
    method: 'Page.navigatedWithinDocument',
    params: { frameId: 'root', url: 'https://ordinary.invalid/page#late' },
  });
  await flush();
  p.release(
    p.held.find((message) => message.id === request.id),
    { result: { privateReply: 'must-not-publish' } }
  );
  assert.match((await request.answer).error?.message ?? '', /^slicc: refused:/);
  assert.doesNotMatch(JSON.stringify(p.delivered), /must-not-publish/);
});
