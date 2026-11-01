import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

for (const message of [
  '{"code":-32000,"message":"DOM agent hasn\'t been enabled"}',
  "DOM agent hasn't been enabled",
  '{"code":-32001,"message":"DOM agent hasn\'t been enabled"}',
  '{"code":-32000,"message":"DOM agent hasn\'t been enabled elsewhere"}',
  "slicc: refused: target is on seven's origin",
]) {
  test(`placement cleanup handles only the exact native disabled-domain error: ${message}`, async (t) => {
    const p = protocol(t, (raw, own) =>
      guardProtected(
        raw,
        own,
        new Map(),
        { kind: 'extension', version: '7.11.1' },
        async () => null
      )
    );
    p.target('root', 'page', plainFrame('root'));
    p.hold(({ id, method }) => id >= 2 ** 30 && method === 'DOM.disable');
    const attaching = p.request('Target.attachToTarget', { targetId: 'root', flatten: true });
    for (let count = 0; count < 20 && !p.held.length; count++) await flush();
    assert.equal(p.held.length, 1, 'placement must reach real cleanup');
    const cleanup = p.held[0];
    p.hold(() => false);
    p.release(cleanup, { error: { code: -32000, message } });
    const attached = await attaching.answer;
    assert.equal(attached.error, undefined);
    await flush();
    const answer = await p.send('Debugger.enable', {}, attached.result.sessionId);
    const benign = message === '{"code":-32000,"message":"DOM agent hasn\'t been enabled"}';
    if (benign) assert.equal(answer.error, undefined, 'no-op DOM cleanup must not fail the scope');
    else assert.match(answer.error?.message ?? '', /refused/);
  });
}
