import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTECTED } from '../../src/seed/guard.js';
import { failed, flush, ordinary, protocol } from './guard-state-fixture.mjs';

for (const navigationType of ['differentDocument', 'sameDocument']) {
  test(`ordinary ${navigationType} load bookkeeping does not hold Input`, async (t) => {
    const wire = protocol(t);
    wire.target('input-ordinary');
    const session = await wire.attach('input-ordinary');
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: 'guard-input-ordinary',
      params: {
        frameId: 'input-ordinary',
        url: ordinary,
        loaderId: 'ordinary-load',
        navigationType,
      },
    });
    await flush();
    assert.equal(
      (await wire.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session)).error,
      undefined
    );
  });
}

for (const protectedLoad of [false, true]) {
  test(`an ordinary partial main commit releases only ordinary history Input ${protectedLoad}`, async (t) => {
    const wire = protocol(t);
    wire.target('input-history');
    const session = await wire.attach('input-history');
    wire.emit({
      method: 'Page.frameStartedNavigating',
      sessionId: 'guard-input-history',
      params: {
        frameId: 'input-history',
        url: protectedLoad ? failed : ordinary,
        loaderId: 'history-navigation-loader',
        navigationType: 'historyDifferentDocument',
      },
    });
    await flush();
    assert.equal(
      (await wire.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session)).error
        ?.message,
      PROTECTED
    );
    wire.emit({
      method: 'Page.frameNavigated',
      sessionId: session,
      params: { frame: { id: 'input-history', url: ordinary } },
    });
    await flush();
    const answer = await wire.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 1, y: 1 },
      session
    );
    assert.equal(answer.error?.message, protectedLoad ? PROTECTED : undefined);
  });
}
