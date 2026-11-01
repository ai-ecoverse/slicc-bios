import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, plainFrame, protocol } from './guard-ordering-fixture.mjs';

const { guardProtected } = await import(process.env.GUARD_SOURCE ?? '../../src/seed/guard.js');

for (const method of ['Page.loadEventFired', 'Page.frameStoppedLoading']) {
  test(`a refused settling root probe is hidden immediately and ${method} cannot revive it`, async (t) => {
    const p = protocol(t, (raw, own) =>
      guardProtected(
        raw,
        own,
        new Map(),
        { kind: 'extension', version: '7.11.1' },
        async () => null
      )
    );
    const root = p.target('root', 'page', { ...plainFrame('root'), loaderId: 'old' });
    const session = await p.attach('root');
    assert.equal((await p.send('Runtime.enable', {}, session)).error, undefined);
    root.tree.frame.loaderId = 'new';
    p.hold(
      ({ id, method, params }) =>
        id >= 2 ** 30 &&
        (method === 'Page.getFrameTree' ||
          (method === 'Runtime.evaluate' && params.expression === 'location.href'))
    );
    p.emit({
      sessionId: session,
      method: 'Page.frameNavigated',
      params: { frame: root.tree.frame },
    });
    const context = {
      id: 31,
      uniqueId: 'refused-root-context',
      name: '',
      origin: 'https://ordinary.invalid',
      auxData: { frameId: 'root', isDefault: true, type: 'default' },
    };
    p.emit({ sessionId: session, method: 'Runtime.executionContextCreated', params: { context } });
    await flush();
    const probe = p.held.find(({ params }) => params.uniqueContextId === context.uniqueId);
    assert.ok(probe);
    p.release(probe, {
      error: { code: -32000, message: "slicc: refused: target is on seven's origin" },
    });
    await flush();
    p.hold(() => false);
    for (const held of [...p.held]) p.release(held);
    await flush();
    const answer = await p.send('Debugger.enable', {}, session);
    assert.match(answer.error?.message ?? '', /browser extension runs scripts/);
    p.emit({ sessionId: session, method, params: { frameId: 'root', timestamp: 1 } });
    await flush();
    assert.match(
      (await p.send('Debugger.enable', {}, session)).error?.message ?? '',
      /browser extension runs scripts/
    );
    assert.equal(
      p.delivered.some(({ method }) => method === 'Runtime.executionContextCreated'),
      false
    );
    assert.equal(
      p.sent.filter(
        ({ method, params }) =>
          method === 'Runtime.evaluate' && params?.uniqueContextId === context.uniqueId
      ).length,
      1
    );
  });
}
